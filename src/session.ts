/**
 * Persistent PowerShell 7 session. One `pwsh` process stays alive across calls so `cd`, `$env:`
 * and variables carry over. Each command is followed by a snapshot line (the processes still
 * running as children of the session) and a sentinel line the reader watches for; everything before
 * them is that command's output, and the fields after the sentinel are `$LASTEXITCODE`, `$?` and
 * the session's current directory. A command that hangs past the timeout, or a session that dies,
 * is discarded and the next call starts a fresh process.
 *
 * Every change to the process's life goes to `opts.log`, which the framework writes into the run's
 * `log.jsonl`; the per-command audit line itself is `toolcalls.jsonl`, which the framework records
 * for any tool call.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from 'cortico/core/types.ts';
import { claimCommand, clearRecord, parseClaim, readRecord, writeRecord, type SessionRecord } from './claim.ts';

/** One process still running as a child of the session when the last command finished. */
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
  /** `$?` for this command — the per-command success flag. */
  ok: boolean;
  /** `$LASTEXITCODE` as a string; empty when no native program ran since the last one did. */
  exitCode: string;
  /** Session directory after the command (`(Get-Location).Path`); empty when the session died or was interrupted. */
  cwd: string;
  /** Direct children of the session still alive after the command — what it left running. */
  procs: LiveProcess[];
  /** Command hit `timeoutMs`; the session was killed and will restart. */
  timedOut: boolean;
  /** Either stream exceeded `maxOutputBytes`. */
  truncated: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/** Status for the console lamp/badge and the environment prompt. */
export interface SessionStatus {
  running: boolean;
  /** The live pwsh process, or null when there is none. */
  pid: number | null;
  cwd: string | null;
  /** Children alive as of the last completed command; empty when no session is running. */
  procs: LiveProcess[];
}

/** The surface `ShellWorld` depends on; `PwshSession` is the real one, tests inject a fake. */
export interface ShellSession {
  run(command: string, opts: RunOptions): Promise<RunResult>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
  status(): SessionStatus;
  start(): Promise<void>;
}

export class ShellError extends Error {}
class AbortedError extends Error {}

/** Read one snapshot line's JSON; a desynced stream costs a snapshot, never the command. */
export function parseLive(json: string): LiveProcess[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .map((e) => ({ pid: Number(e?.pid) || 0, name: String(e?.name ?? ''), cmd: String(e?.cmd ?? '') }))
      .filter((p) => p.pid > 0);
  } catch {
    return [];
  }
}

/**
 * Split the accumulated stdout at the sentinel line, taking the snapshot line just before it out of
 * the command's output. Returns null while the sentinel line is incomplete.
 */
export function splitSentinel(
  buf: string,
  marker: string,
  procMarker: string,
): { stdout: string; exitCode: string; ok: boolean; cwd: string; procs: LiveProcess[]; rest: string } | null {
  const i = buf.indexOf(marker);
  if (i < 0) return null;
  const nl = buf.indexOf('\n', i + marker.length);
  if (nl < 0) return null;
  const line = buf.slice(i, nl);
  const rest = buf.slice(nl + 1);
  // line = marker + "|<exit>|<ok>|<cwd>"; a path has no `|` on any platform, but rejoin just in case
  const parts = line.slice(marker.length).split('|');
  const rawOk = (parts[2] ?? '').trim();
  // lastIndexOf: output that echoes the marker itself must not be mistaken for our snapshot line
  const head = buf.slice(0, i);
  const p = head.lastIndexOf(procMarker);
  let stdout = head;
  let procs: LiveProcess[] = [];
  if (p >= 0) {
    const jsonEnd = head.indexOf('\n', p);
    stdout = head.slice(0, p);
    procs = parseLive(head.slice(p + procMarker.length, jsonEnd < 0 ? undefined : jsonEnd));
  }
  return {
    stdout,
    exitCode: (parts[1] ?? '').trim(),
    ok: rawOk.toLowerCase() === 'true',
    cwd: parts.slice(3).join('|').trim(),
    procs,
    rest,
  };
}

export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
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

/** `PowerShell 7.6.6` → the pieces preflight needs. `powershell` 5.1 parses too, so the caller gates on major. */
export function parseShellVersion(raw: string): { version: string; major: number } | null {
  const m = /PowerShell\s+(\d+)\.(\d+)\.(\d+)/i.exec(raw.trim());
  if (!m) return null;
  return { version: m[0].replace(/\s+/g, ' ').trim(), major: Number(m[1]) };
}

export interface ShellProbe {
  ok: boolean;
  version: string;
  major: number;
  reason: string;
}

/** Read `<shell> --version` once; used by `preflight` and to label the console. */
export function probeShellVersion(shell: string): ShellProbe {
  let r;
  try {
    r = spawnSync(shell, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  } catch (e) {
    return { ok: false, version: '', major: 0, reason: String(e) };
  }
  if (r.error) return { ok: false, version: '', major: 0, reason: r.error.message };
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) return { ok: false, version: out.trim().slice(0, 200), major: 0, reason: `退出码 ${r.status}` };
  const parsed = parseShellVersion(out);
  if (!parsed) return { ok: false, version: out.trim().slice(0, 200), major: 0, reason: '无法解析版本号' };
  return { ok: true, version: parsed.version, major: parsed.major, reason: '' };
}

/** Single-quote a value for PowerShell, escaping embedded quotes. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Ceiling on one snapshot, so a fork bomb cannot flood the prompt. */
const LIVE_CAP = 30;

export interface PwshSessionOptions {
  shell: string;
  /** Start directory for the process; a `''` cwd here still lets the World send `Set-Location`. */
  cwd: string;
  log?: Logger;
  /**
   * Where this session leaves a note of its own pid, so the next generation can recognise and clear
   * it if this process is orphaned by a crash. Undefined = no claim file.
   */
  stateFile?: string;
}

export class PwshSession implements ShellSession {
  readonly version: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private outBuf = '';
  private errBuf = '';
  private counter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly watchers = new Set<() => void>();
  /** Resolves when the live process exits, so an in-flight wait stops instead of hanging to timeout. */
  private exited: Promise<void> = Promise.resolve();
  private resolveExited: () => void = () => {};
  private dead = false;
  /** Last directory reported by a sentinel, so the console lamp and `shell_restart` say where the session really is. */
  private lastCwd = '';
  /** Children reported by the last completed command; replaced wholesale by each snapshot, so it cannot drift. */
  private lastProcs: LiveProcess[] = [];

  constructor(
    private readonly opts: PwshSessionOptions,
    version = '',
  ) {
    this.version = version;
  }

  status(): SessionStatus {
    const running = this.proc !== null && !this.dead;
    return {
      running,
      pid: running ? this.proc?.pid ?? null : null,
      cwd: this.lastCwd || this.opts.cwd || null,
      procs: running ? this.lastProcs : [],
    };
  }

  start(): Promise<void> {
    return this.enqueue(() => this.ensureStarted());
  }

  run(command: string, cfg: RunOptions): Promise<RunResult> {
    return this.enqueue(() => this.doRun(command, cfg));
  }

  restart(): Promise<void> {
    return this.enqueue(async () => {
      this.opts.log?.info('按请求重启会话', { pid: this.proc?.pid });
      this.kill();
      await this.ensureStarted();
    });
  }

  dispose(): Promise<void> {
    return this.enqueue(async () => {
      if (this.proc) this.opts.log?.info('会话已关闭', { pid: this.proc.pid });
      this.kill();
    });
  }

  /** Serialize every operation on the single process. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  private kill(): void {
    const p = this.proc;
    if (p && this.lastProcs.length) {
      // Killing pwsh does not kill what it started; say so instead of losing the thread.
      this.opts.log?.warn('会话已丢弃,它起的进程仍在运行', {
        pid: p.pid,
        left: this.lastProcs.map((x) => `${x.name}(${x.pid})`).join(', '),
      });
    }
    this.lastProcs = [];
    this.proc = null;
    this.outBuf = '';
    this.errBuf = '';
    this.dead = true;
    // This one is accounted for: the next generation has nothing to claim.
    if (p && this.opts.stateFile) clearRecord(this.opts.stateFile, p.pid ?? 0);
    for (const w of this.watchers) w();
    if (p && !p.killed) {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.proc && !this.dead) return Promise.resolve();
    this.dead = false;
    this.outBuf = '';
    this.errBuf = '';
    // Read before this process exists: whatever the file says belongs to the generation before ours.
    const file = this.opts.stateFile;
    const stale = file ? readRecord(file) : null;
    const born = Date.now();
    const proc = spawn(this.opts.shell, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], {
      cwd: this.opts.cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (file) {
      // Written before the process is known-good, so even a pwsh that dies on the way in is claimable.
      const why = writeRecord(file, { pid: proc.pid ?? 0, startedMs: born, shell: this.opts.shell, cwd: this.opts.cwd });
      if (why) this.opts.log?.warn('会话记录写不下去,崩掉后就没人认领它了', { file, reason: why });
    }
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    // Writing to a process that just died must surface as a failed command, not an unhandled stream error.
    proc.stdin.on('error', () => {});
    this.proc = proc;
    // Every handler is guarded by process identity: a killed process's async exit must not clobber
    // the state of a session that has since respawned.
    proc.stdout.on('data', (d: string) => { if (this.proc !== proc) return; this.outBuf += d; this.notify(); });
    proc.stderr.on('data', (d: string) => { if (this.proc !== proc) return; this.errBuf += d; });
    this.exited = new Promise<void>((res) => { this.resolveExited = res; });
    const end = (detail: string): void => {
      if (this.proc !== proc) return;
      // Only a death we did not cause reaches here: kill() clears this.proc first.
      this.opts.log?.warn('pwsh 会话进程结束', { pid: proc.pid, detail });
      this.dead = true;
      this.proc = null;
      this.resolveExited();
      this.notify();
    };
    proc.on('exit', (code, signal) => end(`code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    proc.on('error', (e) => end(`error=${String(e)}`));

    const ready = `__CSH_READY_${++this.counter}__`;
    const init = [
      `$ErrorActionPreference='Continue'`,
      `$ProgressPreference='SilentlyContinue'`,
      `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}`,
      `$OutputEncoding=[System.Text.Encoding]::UTF8`,
      `try { $PSStyle.OutputRendering='PlainText' } catch {}`,
      this.opts.cwd ? `if (Test-Path -LiteralPath ${psq(this.opts.cwd)}) { Set-Location -LiteralPath ${psq(this.opts.cwd)} }` : '',
      `Write-Output ${psq(ready)}; [Console]::Out.Flush()`,
    ].filter(Boolean).join('\n');
    proc.stdin.write(`${init}\n`);

    return this.waitUntil(() => this.outBuf.includes(ready), 20_000, undefined)
      .then(async () => {
        const i = this.outBuf.indexOf(ready);
        this.outBuf = this.outBuf.slice(this.outBuf.indexOf('\n', i) + 1);
        this.lastCwd = this.opts.cwd;
        this.opts.log?.info('pwsh 会话已启动', { shell: this.opts.shell, pid: proc.pid, cwd: this.opts.cwd || undefined });
        if (stale && stale.pid !== proc.pid) await this.claimStale(stale, proc.pid ?? 0);
      })
      .catch((e) => {
        const reason = e instanceof Error ? e.message : String(e);
        this.opts.log?.warn('pwsh 会话启动失败', {
          shell: this.opts.shell, reason, stderr: normalizeEol(this.errBuf).slice(0, 200) || undefined,
        });
        this.kill();
        if (e instanceof AbortedError) throw e;
        throw new ShellError(`启动 PowerShell(${this.opts.shell})失败:${reason}`);
      });
  }

  /**
   * A live process to write to. `ensureStarted` can resolve with none: the exit event is delivered
   * asynchronously, so a process can die in the gap between the await and this write. Replacing it
   * costs the session's variables, which is what a dead process already cost us; crashing does not.
   */
  private async liveProc(): Promise<ChildProcessWithoutNullStreams> {
    for (let tries = 0; tries < 3; tries++) {
      await this.ensureStarted();
      const p = this.proc;
      if (p) return p;
    }
    throw new ShellError('PowerShell 会话起不来');
  }

  /**
   * Clear the pwsh a previous generation was killed and left behind, then say what it left running.
   * This runs as one command inside the session that just came up, so claiming costs no extra process.
   */
  private async claimStale(stale: SessionRecord, self: number): Promise<void> {
    const log = this.opts.log;
    try {
      const r = await this.doRun(claimCommand(stale.pid, self, stale.startedMs), { timeoutMs: 8_000, maxOutputBytes: 4_000 });
      const claim = parseClaim(r.stdout);
      const left = claim.kids.length ? claim.kids.map((x) => `${x.name}(${x.pid})`).join(', ') : undefined;
      if (claim.killed) {
        log?.warn('清掉了上一代遗留的 PowerShell 会话', { pid: stale.pid, started: new Date(stale.startedMs).toISOString(), left });
      } else if (claim.reason !== 'gone') {
        // 'not-ours' / 'still-alive' / an unreadable answer: leave it alone and say so.
        log?.warn('上一代留下的会话没认领', { pid: stale.pid, reason: claim.reason, left });
      }
    } catch (e) {
      log?.warn('认领上一代会话时出错', { pid: stale.pid, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  private async doRun(command: string, cfg: RunOptions): Promise<RunResult> {
    const proc = await this.liveProc();
    this.errBuf = '';
    const marker = `__CSH_${++this.counter}_${Math.random().toString(36).slice(2, 10)}__`;
    const procMarker = `__CSH_P_${this.counter}__`;
    // Capture $LASTEXITCODE, $? and the directory before anything else runs: a separate statement in
    // between would reset $? to True. The snapshot query is deliberately last, so it cannot colour the
    // verdict of the user's command. Concatenate, never interpolate into a single-quoted literal.
    const emit = [
      `$__cs=${psq(`${marker}|`)} + $LASTEXITCODE + ${psq('|')} + $? + ${psq('|')} + $(try { (Get-Location).Path } catch { '' })`,
      // conhost.exe is the console host Windows hangs off this session, not something the bot started.
      `$__cp=@(); try { $__cp=@(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$PID AND Name!='conhost.exe'" | Select-Object -First ${LIVE_CAP} @{n='pid';e={$_.ProcessId}},@{n='name';e={$_.Name}},@{n='cmd';e={$_.CommandLine}}) } catch {}`,
      `Write-Output (${psq(procMarker)} + (ConvertTo-Json -Compress -InputObject $__cp))`,
      `Write-Output $__cs; [Console]::Out.Flush()`,
    ].join('\n');
    proc.stdin.write(`${command}\n${emit}\n`);

    try {
      await this.waitUntil(() => splitSentinel(this.outBuf, marker, procMarker) !== null, cfg.timeoutMs, cfg.signal);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const partial = normalizeEol(this.outBuf);
      if (e instanceof AbortedError) {
        this.outBuf = '';
        // The command may still be running in the live process; its state is unknown until the next one settles.
        this.opts.log?.warn('命令被中断,会话状态未知', { reason, timeoutMs: cfg.timeoutMs, partialBytes: Buffer.byteLength(partial, 'utf8') });
        return { stdout: partial, stderr: normalizeEol(this.errBuf), ok: false, exitCode: '', cwd: '', procs: this.lastProcs, timedOut: false, truncated: false };
      }
      // timeout or the process died mid-command: the sentinel never came, so state is unknown.
      this.opts.log?.warn('命令未完成,会话已丢弃', { reason, timeoutMs: cfg.timeoutMs, partialBytes: Buffer.byteLength(partial, 'utf8') });
      this.kill();
      return { stdout: partial, stderr: normalizeEol(this.errBuf), ok: false, exitCode: '', cwd: '', procs: [], timedOut: true, truncated: false };
    }

    const split = splitSentinel(this.outBuf, marker, procMarker)!;
    this.outBuf = split.rest;
    if (split.cwd) this.lastCwd = split.cwd;
    this.lastProcs = split.procs;

    let stdout = normalizeEol(split.stdout);
    let stderr = normalizeEol(this.errBuf);
    let truncated = false;
    const tOut = truncateBytes(stdout, cfg.maxOutputBytes);
    if (tOut) { stdout = tOut.text; truncated = true; }
    const tErr = truncateBytes(stderr, cfg.maxOutputBytes);
    if (tErr) { stderr = tErr.text; truncated = true; }

    return {
      stdout, stderr, ok: split.ok, exitCode: split.exitCode, cwd: split.cwd,
      procs: split.procs, timedOut: false, truncated,
    };
  }

  private notify(): void {
    for (const w of [...this.watchers]) w();
  }

  private waitUntil(cond: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (cond()) { resolve(); return; }
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        clearTimeout(timer);
        this.watchers.delete(watch);
        signal?.removeEventListener('abort', onAbort);
        this.exited.then(() => {}, () => {});
      };
      const watch = (): void => {
        if (!settled && cond()) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => { if (!settled) { cleanup(); reject(new ShellError(`命令超时(${timeoutMs}ms)`)); } }, timeoutMs);
      const onAbort = (): void => { if (!settled) { cleanup(); reject(new AbortedError()); } };
      signal?.addEventListener('abort', onAbort);
      this.watchers.add(watch);
      // a process exit that doesn't satisfy cond must fail the wait, not hang to timeout
      this.exited.then(() => { if (!settled && !cond()) { cleanup(); reject(new ShellError('会话已结束')); } });
      watch();
    });
  }
}
