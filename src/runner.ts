/**
 * One command, one process.
 *
 * A run spawns a fresh shell and reads it to its end: `niu` (Niubash/bash) or `pwsh` (PowerShell 7),
 * chosen by the configured executable's name. Nothing survives the call — directory, variables and
 * shell state die with the process — and a timeout or an interruption terminates that process tree,
 * so there is no session state to restart and none to leave unknown. `niu -c` loads no rc and no
 * plugins by design; `pwsh -NoProfile` loads no profile.
 *
 * Each dialect gets a short epilogue that captures the command's status before anything else, then
 * lists the direct children still running — the processes that outlive the shell. The bash
 * epilogue captures `$?`, turns errexit off, and settles `$PWD` physically; the PowerShell one
 * captures `$?` and `$LASTEXITCODE`, resets error/strict preferences, and reads the directory and
 * children through `Get-Location` / `Get-CimInstance`. Both end with the same sentinel and process
 * rows, so `splitSentinel` reads either. A command that ends the shell early (`exit`, a parse
 * error) never reaches the epilogue; its receipt says so instead of inventing a verdict.
 */
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from 'cortico/core/types.ts';

/** Which command language the configured executable speaks. */
export type ShellKind = 'bash' | 'pwsh';

/** `pwsh` / `powershell` are PowerShell; everything else (niu) is the bash dialect. */
export function shellKind(shell: string): ShellKind {
  const base = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  return base === 'pwsh' || base === 'powershell' ? 'pwsh' : 'bash';
}

/** One process still running as a child of the command's shell when it finished. */
export interface LiveProcess {
  pid: number;
  name: string;
  /** Its command line; empty for processes Windows hides from us. */
  cmd: string;
}

/** Result of one command, as the World sees it. */
export interface RunResult {
  stdout: string;
  stderr: string;
  /** The command's exit status: `$?` was 0. */
  ok: boolean;
  /** `$?` as a string; empty when there is no receipt (the epilogue never ran and the process status is unknown). */
  exitCode: string;
  /** Directory after the command (`$PWD`, physical form); empty when there is no receipt. */
  cwd: string;
  /** Direct children of the command's shell still alive when it finished — what it left running. */
  procs: LiveProcess[];
  /** The command outlived `timeoutMs`; its process was terminated. */
  timedOut: boolean;
  /** The call was interrupted; its process was terminated. */
  aborted: boolean;
  /** The script never reached the epilogue; `ok`/`exitCode` are the shell's own process status. */
  incomplete: boolean;
  /** Either stream exceeded `maxOutputBytes`. */
  truncated: boolean;
}

/** Everything one run needs: the command, the live config, and how long it may take. */
export interface RunSpec {
  shell: string;
  /** Working directory for this process; every command starts here. */
  cwd: string;
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  log?: Logger;
}

/** The surface `ShellWorld` depends on; `runCommand` is the real one, tests inject a fake. */
export type RunShell = (spec: RunSpec) => Promise<RunResult>;

export class ShellError extends Error {}

export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
}

/** Strip ANSI SGR sequences, so colored diagnostics in stderr stay readable. */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Keep head and tail, dropping the middle; returns null when nothing to drop. */
export function truncateBytes(s: string, max: number): { text: string; truncated: true; omitted: number } | null {
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= max) return null;
  const headBytes = Math.floor(max * 0.6);
  const tailBytes = max - headBytes;
  const buf = Buffer.from(s, 'utf8');
  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(bytes - tailBytes).toString('utf8');
  const omitted = bytes - headBytes - tailBytes;
  return { text: `${head}\n…[省略 ${omitted} 字节]…\n${tail}`, truncated: true, omitted };
}

/** How much of one stream stays in memory; the middle is dropped past this. */
const CAPTURE_HEAD_CHARS = 1_000_000;
const CAPTURE_TAIL_CHARS = 1_000_000;

/**
 * Bounded stdout/stderr capture. A command that prints without end must not grow the host's heap;
 * the tail window keeps the sentinel and its process snapshot. The slack lets trimming happen once
 * per slack-sized chunk instead of copying the windows on every chunk.
 */
export class BoundedLog {
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(
    private readonly headChars = CAPTURE_HEAD_CHARS,
    private readonly tailChars = CAPTURE_TAIL_CHARS,
    private readonly slackChars = CAPTURE_TAIL_CHARS,
  ) {}

  get truncated(): boolean {
    return this.dropped > 0;
  }

  push(chunk: string): void {
    if (this.head.length < this.headChars) {
      const room = this.headChars - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    const limit = this.tailChars + this.slackChars;
    if (this.tail.length > limit) {
      this.dropped += this.tail.length - this.tailChars;
      this.tail = this.tail.slice(-this.tailChars);
    }
  }

  text(): string {
    return this.head + this.tail;
  }
}

/** `Niubash 1.3.3 — bash-compatible shell for Windows` → the pieces preflight needs. */
export function parseNiuVersion(raw: string): { version: string; major: number } | null {
  const m = /Niubash\s+(\d+)\.(\d+)\.(\d+)/i.exec(raw.trim());
  if (!m) return null;
  return { version: `Niubash ${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]) };
}

export interface ShellProbe {
  ok: boolean;
  kind: ShellKind;
  version: string;
  major: number;
  reason: string;
}

/** Read `<shell> --version` once for the Niubash dialect. */
export function probeShellVersion(shell: string): ShellProbe {
  let r;
  try {
    r = spawnSync(shell, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  } catch (e) {
    return { ok: false, kind: 'bash', version: '', major: 0, reason: String(e) };
  }
  if (r.error) return { ok: false, kind: 'bash', version: '', major: 0, reason: r.error.message };
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) return { ok: false, kind: 'bash', version: out.trim().slice(0, 200), major: 0, reason: `退出码 ${r.status}` };
  const parsed = parseNiuVersion(out);
  if (!parsed) return { ok: false, kind: 'bash', version: out.trim().slice(0, 200), major: 0, reason: '无法解析版本号' };
  return { ok: true, kind: 'bash', version: parsed.version, major: parsed.major, reason: '' };
}

/** `PowerShell 7.6.7` → the pieces preflight needs. */
export function parsePowerShellVersion(raw: string): { version: string; major: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return { version: `PowerShell ${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]) };
}

/** Read the PowerShell version without loading a profile. */
export function probePowerShell(shell: string): ShellProbe {
  let r;
  try {
    r = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
  } catch (e) {
    return { ok: false, kind: 'pwsh', version: '', major: 0, reason: String(e) };
  }
  if (r.error) return { ok: false, kind: 'pwsh', version: '', major: 0, reason: r.error.message };
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) return { ok: false, kind: 'pwsh', version: out.trim().slice(0, 200), major: 0, reason: `退出码 ${r.status}` };
  const parsed = parsePowerShellVersion(out);
  if (!parsed) return { ok: false, kind: 'pwsh', version: out.trim().slice(0, 200), major: 0, reason: '无法解析版本号' };
  return { ok: true, kind: 'pwsh', version: parsed.version, major: parsed.major, reason: '' };
}

/** Probe whichever dialect the configured executable name selects. */
export function probeShellProgram(shell: string): ShellProbe {
  return shellKind(shell) === 'pwsh' ? probePowerShell(shell) : probeShellVersion(shell);
}

/** One `ps -e -o pid,ppid,comm,args` row → the pieces the receipt reports. */
export function parseProcLine(raw: string): LiveProcess | null {
  const m = /^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(raw.trim());
  if (!m) return null;
  const pid = Number(m[1]);
  if (!(pid > 0)) return null;
  return { pid, name: m[3], cmd: m[4] ?? '' };
}

/**
 * Split a finished script's stdout at the sentinel line. The snapshot rows are the trailing run of
 * lines that start with `procMarker`; everything before them is the command's own output. Returns
 * null when the epilogue never ran.
 */
export function splitSentinel(
  buf: string,
  marker: string,
  procMarker: string,
): { stdout: string; exitCode: string; cwd: string; procs: LiveProcess[] } | null {
  // The last marker wins: the real sentinel is the shell's last stdout line before it exits, and
  // an earlier marker-shaped line can only be command output.
  const i = buf.lastIndexOf(marker);
  if (i < 0) return null;
  const nl = buf.indexOf('\n', i + marker.length);
  if (nl < 0) return null;
  const line = buf.slice(i, nl);
  // line = marker|<exit>|<cwd>; a path has no `|` on Windows, but rejoin just in case
  const parts = line.slice(marker.length).split('|');
  let head = buf.slice(0, i);
  // The sentinel line's own LF, then the rows (or the separator LF) as lines.
  if (head.endsWith('\n')) head = head.slice(0, -1);
  const lines = head.split('\n');
  const procs: LiveProcess[] = [];
  while (lines.length && lines[lines.length - 1].startsWith(procMarker)) {
    const p = parseProcLine(lines.pop()!.slice(procMarker.length));
    if (p) procs.unshift(p);
  }
  // The epilogue prints a leading LF so its rows never merge with output lacking a trailing
  // newline; drop exactly that one empty line (the user's own trailing newlines stay).
  if (lines[lines.length - 1] === '') lines.pop();
  return {
    stdout: lines.join('\n'),
    exitCode: (parts[1] ?? '').trim(),
    cwd: parts.slice(2).join('|').trim(),
    procs,
  };
}

/** The whole script one shell receives: the command verbatim, then the epilogue. */
export function buildScript(command: string, marker: string, procMarker: string): string {
  return [
    command,
    '__csh_ec=$?',
    // The command may have enabled errexit; its last statement's status is captured above, and the
    // epilogue's own commands must not be able to exit before the sentinel.
    'set +e',
    // rubash resolves a dialect path (`cd /tmp`) lazily in `$PWD`; a physical `cd` settles it and
    // also resolves links, so the receipt path points where the process really is. A command that
    // removed its own directory just leaves the last known `$PWD` in place.
    'cd -P . 2>/dev/null',
    // A fresh line, so the snapshot rows never merge with output that lacks a trailing newline.
    "printf '\\n'",
    // `ps` and the applets are part of Niubash's winuxcmd layer: same column order, `--no-headers`.
    'ps -e -o pid,ppid,comm,args --no-headers 2>/dev/null | while IFS= read -r __csh_line; do',
    // Field slicing by parameter expansion, not `set --`: a command that ran `set -u` or changed
    // `IFS` must not break the epilogue. `$$` is this shell's pid, even inside the pipeline subshell.
    '  __csh_rest=${__csh_line#* }',
    '  __csh_ppid=${__csh_rest%% *}',
    '  [ "$__csh_ppid" = "$$" ] || continue',
    '  __csh_comm=${__csh_rest#* }',
    '  __csh_comm=${__csh_comm%% *}',
    // conhost.exe is the console host Windows hangs off this process; ps.exe is this snapshot itself.
    '  case "$__csh_comm" in conhost.exe|ps.exe) continue ;; esac',
    `  printf '${procMarker}%s\\n' "$__csh_line"`,
    'done',
    `printf '${marker}|%s|%s\\n' "$__csh_ec" "$PWD"`,
  ].join('\n');
}

/** The whole PowerShell script one shell receives: UTF-8 output, the command verbatim, then the epilogue. */
export function buildPwshScript(command: string, marker: string, procMarker: string): string {
  return [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    command,
    // Capture $? before any other statement: the next assignment would reset it to True. A
    // terminating error or StrictMode can make $LASTEXITCODE unreadable; the receipt then falls
    // back to $?.
    '$__csh_ok = $?',
    'try { $__csh_last = $LASTEXITCODE } catch { $__csh_last = $null }',
    // A command may leave Stop / StrictMode behind; the epilogue must still reach the sentinel.
    '$ErrorActionPreference = "Continue"',
    'Set-StrictMode -Off',
    // One exit number for the receipt: 0 on success, the last native code on failure, else 1.
    '$__csh_exit = if (-not $__csh_ok) { if ($__csh_last -is [int] -and $__csh_last -ne 0) { $__csh_last } else { 1 } } else { 0 }',
    '$__csh_cwd = $(try { (Get-Location).ProviderPath } catch { "" })',
    'Write-Output ""',
    // conhost.exe is the console host Windows hangs off this process, not something the command started.
    '$__csh_procs = @(); try { $__csh_procs = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$PID AND Name!=\'conhost.exe\'" | Select-Object -First 30) } catch {}',
    `$__csh_procs | ForEach-Object { Write-Output ("${procMarker}{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine) }`,
    `Write-Output ("${marker}|$__csh_exit|$__csh_cwd")`,
  ].join('\n');
}

/** Ceiling on the script handed over as a command-line argument (Windows caps one at 32767 units). */
export const MAX_SCRIPT_CHARS = 30_000;

/** A Windows exit code arrives as a uint32; `-1` reads better than `4294967295`. */
function toSigned32(code: number): number {
  return code > 0x7fffffff ? code - 0x1_0000_0000 : code;
}

/** Terminate the shell and its descendants; on Windows SIGKILL only reaches the direct child. */
function killTree(proc: ChildProcessByStdio<null, Readable, Readable>): void {
  const pid = proc.pid;
  if (process.platform === 'win32' && pid) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch {
      // Fall through to the direct kill.
    }
  }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Run one command to its end. Resolves with the receipt; a shell that cannot even be started
 * rejects with `ShellError`, which the World turns into a failed tool outcome.
 */
export function runCommand(spec: RunSpec): Promise<RunResult> {
  const tag = randomBytes(6).toString('hex');
  const marker = `__CSH_${tag}__`;
  const procMarker = `__CSH_P_${tag}__`;
  const kind = shellKind(spec.shell);
  const script = kind === 'pwsh'
    ? buildPwshScript(spec.command, marker, procMarker)
    : buildScript(spec.command, marker, procMarker);
  if (script.length > MAX_SCRIPT_CHARS) {
    return Promise.reject(new ShellError(`命令太长(拼出的脚本 ${script.length} 字符,接近 Windows 命令行上限),拆成几条跑。`));
  }
  return new Promise<RunResult>((resolve, reject) => {
    if (spec.signal?.aborted) {
      // Never started, nothing to kill; an empty interrupted receipt says exactly that.
      resolve({ stdout: '', stderr: '', ok: false, exitCode: '', cwd: '', procs: [], timedOut: false, aborted: true, incomplete: false, truncated: false });
      return;
    }
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn(spec.shell, kind === 'pwsh'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
        : ['-c', script], {
        cwd: spec.cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(new ShellError(`启动 shell(${spec.shell})失败:${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const out = new BoundedLog();
    const err = new BoundedLog();
    let settled = false;
    let exitCode: number | null = null;
    /** Grace after the shell exited, for its last pipe chunks to arrive. */
    const DRAIN_MS = 100;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    const release = (): void => {
      // Background children inherit these pipes. Without destroying them, Node waits on the write
      // ends until the orphans exit — `close` never fires, and the event loop stays alive too.
      try { proc.stdout.destroy(); } catch { /* already closed */ }
      try { proc.stderr.destroy(); } catch { /* already closed */ }
      proc.unref();
    };

    /** What was captured so far, normalised and truncated like a full receipt. */
    const streams = (): { stdout: string; stderr: string; truncated: boolean } => {
      let stdout = normalizeEol(out.text());
      let stderr = stripAnsi(normalizeEol(err.text()));
      let truncated = out.truncated || err.truncated;
      const tOut = truncateBytes(stdout, spec.maxOutputBytes);
      if (tOut) { stdout = tOut.text; truncated = true; }
      const tErr = truncateBytes(stderr, spec.maxOutputBytes);
      if (tErr) { stderr = tErr.text; truncated = true; }
      return { stdout, stderr, truncated };
    };

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      spec.signal?.removeEventListener('abort', onAbort);
      release();
      resolve(result);
    };
    const kill = (): void => killTree(proc);

    let drain: NodeJS.Timeout | null = null;
    const settle = (): void => {
      finish(finalize(out.text(), err.text(), exitCode, spec, marker, procMarker, proc.pid ?? 0, out.truncated || err.truncated));
    };

    proc.stdout.on('data', (d: string) => out.push(d));
    proc.stderr.on('data', (d: string) => err.push(d));

    const onAbort = (): void => {
      const s = streams();
      spec.log?.warn('命令被中断,进程树已终止', { pid: proc.pid, partialBytes: Buffer.byteLength(s.stdout, 'utf8') });
      kill();
      finish({ ...s, ok: false, exitCode: '', cwd: '', procs: [], timedOut: false, aborted: true, incomplete: false });
    };
    const timer = setTimeout(() => {
      const s = streams();
      spec.log?.warn('命令超时,进程树已终止', { pid: proc.pid, timeoutMs: spec.timeoutMs, partialBytes: Buffer.byteLength(s.stdout, 'utf8') });
      kill();
      finish({ ...s, ok: false, exitCode: '', cwd: '', procs: [], timedOut: true, aborted: false, incomplete: false });
    }, spec.timeoutMs);

    // `error` covers a spawn that never started. `exit` is the shell's own end; the short drain lets
    // its last chunks land, then the receipt is assembled. Settling only on exit means a
    // marker-shaped line printed by the command cannot make the call return while the shell still
    // runs. `close` is the ideal end, but background children may hold the pipes open.
    proc.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      spec.log?.warn('shell 进程启动失败', { shell: spec.shell, cwd: spec.cwd || undefined, reason: e.message });
      reject(new ShellError(`启动 shell(${spec.shell})失败:${e.message}`));
    });
    proc.on('exit', (code) => {
      exitCode = code;
      if (!settled && !drain) drain = setTimeout(settle, DRAIN_MS);
    });
    proc.on('close', (code) => { exitCode = code; settle(); });
    proc.on('spawn', () => {
      spec.log?.info('shell 进程已启动', { pid: proc.pid, shell: spec.shell, cwd: spec.cwd || undefined });
    });
    spec.signal?.addEventListener('abort', onAbort);
  });
}

/** Assemble the receipt from a process that ended on its own. */
function finalize(
  out: string,
  err: string,
  code: number | null,
  spec: RunSpec,
  marker: string,
  procMarker: string,
  pid: number,
  preTruncated: boolean,
): RunResult {
  const split = splitSentinel(out, marker, procMarker);
  let stdout: string;
  let stderr = stripAnsi(normalizeEol(err));
  let ok: boolean;
  let exitCode: string;
  let cwd = '';
  let procs: LiveProcess[] = [];
  let incomplete = false;
  if (split) {
    stdout = split.stdout;
    exitCode = split.exitCode;
    ok = exitCode === '0';
    cwd = split.cwd;
    procs = split.procs;
  } else {
    // `exit`, a parse error or a terminating failure ended the shell before the epilogue could run.
    incomplete = true;
    ok = code === 0;
    exitCode = code === null ? '' : String(toSigned32(code));
    spec.log?.warn('命令没跑到收尾,回执不完整', { pid, exitCode: exitCode || undefined });
    stdout = normalizeEol(out);
  }
  let truncated = preTruncated;
  const tOut = truncateBytes(stdout, spec.maxOutputBytes);
  if (tOut) { stdout = tOut.text; truncated = true; }
  const tErr = truncateBytes(stderr, spec.maxOutputBytes);
  if (tErr) { stderr = tErr.text; truncated = true; }
  return { stdout, stderr, ok, exitCode, cwd, procs, timedOut: false, aborted: false, incomplete, truncated };
}
