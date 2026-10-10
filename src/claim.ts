/**
 * Claiming the previous generation's leftover session.
 *
 * A graceful app stop runs `dispose()` and kills the pwsh session with it. A crash or a forced kill
 * does not: the pwsh process outlives its parent and keeps a directory, variables and a stdin pipe
 * nobody will ever write to again. So each session records its own pid and process-start time in a
 * file under the World's data directory, and the next session that starts reads that file and,
 * after proving the process really is its predecessor, kills it — and reports what that one left
 * running, because killing a shell never kills what the shell launched.
 *
 * The check itself runs inside the new session (one more command, no extra process), and only a
 * record whose pid, executable name and command-line signature all match, within a few seconds of
 * the recorded start time, is touched. Anything else is left alone: stealing a stranger's shell is
 * far worse than leaking one of ours.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LiveProcess } from './session.ts';
import { parseLive } from './session.ts';

/** What a session writes about itself while it lives. */
export interface SessionRecord {
  pid: number;
  /** `Date.now()` at spawn, compared against the OS's own process creation time. */
  startedMs: number;
  shell: string;
  cwd: string;
}

/** A pid this far off the recorded start time is somebody else's process that reused the number. */
const PID_REUSE_WINDOW_MS = 10_000;

export const CLAIM_MARKER = '__CSH_CLAIM__';

/** Single-quote a value for PowerShell, escaping embedded quotes. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function writeRecord(file: string, rec: SessionRecord): string | null {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(rec), 'utf8');
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Drop our own record on a clean stop, so the next start has nothing to claim. */
export function clearRecord(file: string, pid: number): void {
  const rec = readRecord(file);
  if (!rec || rec.pid !== pid) return; // somebody else's session already rewrote it
  try {
    rmSync(file, { force: true });
  } catch { /* it is only a hint; a stale file is claimed later */ }
}

/** A damaged or absent file just means nothing to claim. */
export function readRecord(file: string): SessionRecord | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<SessionRecord>;
    const pid = Number(v?.pid);
    const startedMs = Number(v?.startedMs);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(startedMs) || startedMs <= 0) return null;
    return { pid, startedMs, shell: String(v?.shell ?? ''), cwd: String(v?.cwd ?? '') };
  } catch {
    return null;
  }
}

export interface ClaimResult {
  killed: boolean;
  reason: string;
  /** Processes the dead session left running (its direct children, minus the console host). */
  kids: LiveProcess[];
}

/**
 * The PowerShell that asks for, checks and kills the stale session. `target` and `self` are pids
 * this module validated, and the creation-time bound is a plain integer, so nothing here is
 * built from text that a caller could shape.
 *
 * Every line must be a *complete* statement. This runs over the session's stdin, where `-Command -`
 * parses line by line: an `elseif` on its own line has no open `if` to attach to, and the resulting
 * parse error aborts the script — including the session's own sentinel — leaving nobody to read the
 * answer. So the branches are independent one-liners that overwrite a running verdict.
 */
export function claimCommand(target: number, self: number, startedMs: number): string {
  const floor = startedMs - PID_REUSE_WINDOW_MS;
  const ceil = startedMs + PID_REUSE_WINDOW_MS;
  return [
    `$__cl = [ordered]@{ killed = $false; reason = ''; kids = @() }`,
    `$__cr = $null; try { $__cr = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${target} AND ProcessId != ${self}" } catch {}`,
    // CIM's CreationDate arrives as a string, so the OS start time comes from Get-Process instead;
    // a process whose start time we cannot read (another user's) fails the window check below, which
    // is exactly the safe direction.
    `$__st = $null; try { $__st = (Get-Process -Id ${target} -ErrorAction Stop).StartTime } catch {}`,
    `$__same = $false; $__born = 0; if ($__cr -and $__st) { try { $__born = [DateTimeOffset]::new($__st).ToUnixTimeMilliseconds() } catch {}; $__same = ($__cr.Name -replace '\\.exe$','') -eq (Get-Process -Id $PID).ProcessName }`,
    // Only a process that is the same executable as this one, launched with exactly our session
    // arguments, and born when we recorded it, counts as our predecessor.
    `$__ours = $false; if ($__cr) { $__ours = ($__same -and $__cr.CommandLine -match '-NoProfile -NoLogo -NonInteractive -Command' -and $__born -ge ${floor} -and $__born -le ${ceil}) }`,
    `$__cl.reason = 'gone'; if ($__cr) { $__cl.reason = 'not-ours' }; if ($__ours) { $__cl.reason = 'ours' }`,
    `if ($__cl.reason -eq 'ours') { try { $__cl.kids = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=${target} AND Name!='conhost.exe'" | Select-Object -First 30 @{n='pid';e={$_.ProcessId}},@{n='name';e={$_.Name}},@{n='cmd';e={$_.CommandLine}}) } catch {} }`,
    `$__al = $false; if ($__cl.reason -eq 'ours') { Stop-Process -Id ${target} -Force -ErrorAction SilentlyContinue; $__al = [bool](Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${target}" -ErrorAction SilentlyContinue) }`,
    `if ($__al) { $__cl.reason = 'still-alive' }`,
    `if ($__ours -and -not $__al) { $__cl.killed = $true; $__cl.reason = 'killed' }`,
    // The marker must be a quoted string: a bare word here is a parse error, and PowerShell then
    // swallows the rest of the buffered command — including the session's own sentinel.
    `Write-Output (${psq(CLAIM_MARKER)} + (ConvertTo-Json -Compress -InputObject $__cl)); [Console]::Out.Flush()`,
  ].join('\n');
}

/** Read the claim line out of that command's stdout. */
export function parseClaim(stdout: string): ClaimResult {
  const i = stdout.indexOf(CLAIM_MARKER);
  if (i < 0) return { killed: false, reason: 'no-claim-line', kids: [] };
  const nl = stdout.indexOf('\n', i);
  const json = stdout.slice(i + CLAIM_MARKER.length, nl < 0 ? undefined : nl);
  try {
    const v = JSON.parse(json) as { killed?: unknown; reason?: unknown; kids?: unknown };
    return {
      killed: v.killed === true,
      reason: String(v.reason ?? ''),
      kids: parseLive(JSON.stringify(Array.isArray(v.kids) ? v.kids : [v.kids ?? null])),
    };
  } catch {
    return { killed: false, reason: 'bad-json', kids: [] };
  }
}
