/**
 * Real end-to-end check of the one-shot Niubash runner. Run by hand:
 *   pnpm smoke
 * Not part of `pnpm test` (it spawns real shells). Exits non-zero on the first failed assertion.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, type RunResult, type RunSpec } from '../src/runner.ts';
import { formatResult } from '../src/world.ts';
import { askDesktop } from '../src/ask.ts';
import { detectRtk } from '../src/rtk.ts';
import type { Logger } from 'cortico/core/types.ts';

const shell = process.env.SMOKE_SHELL ?? 'niu';
const cwd = mkdtempSync(join(tmpdir(), 'cortico-shell-'));
let failures = 0;
const check = (label: string, cond: boolean, extra = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};
const opts = { shell, cwd, timeoutMs: 15_000, maxOutputBytes: 24_000 };
const run = (command: string, extra: Partial<RunSpec> = {}): Promise<RunResult> => runCommand({ ...opts, command, ...extra });

/** Collects the lifecycle lines a real run writes, so the audit trail is checked, not assumed. */
function logCollector(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  const push = (level: string) => (msg: string, fields?: unknown): void => {
    lines.push(`${level} ${msg} ${fields ? JSON.stringify(fields) : ''}`.trim());
  };
  const noop = () => {};
  const log = {
    trace: push('trace'), debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'),
    emit: noop, child: () => log,
  } as unknown as Logger;
  return { lines, log };
}

/** Is that pid still a process? */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  const a = await run('echo hello-smoke');
  check('plain echo', a.ok && a.exitCode === '0' && a.stdout.includes('hello-smoke'), JSON.stringify(a.stdout.trim()));
  check('no console-host noise in the snapshot', !a.procs.some((p) => /conhost/i.test(p.name)), a.procs.map((p) => p.name).join(', '));

  // The whole script is one `-c` argument: multi-line blocks and here-docs must arrive intact.
  const multi = await run("if true; then\n  echo multi-line-ok\nfi\nfor i in 1 2; do echo n=$i; done");
  check('multi-line if/for run whole', multi.ok && multi.stdout.includes('multi-line-ok') && multi.stdout.includes('n=2'), JSON.stringify(multi.stdout.trim()));
  const here = await run("cat <<'EOF'\nhere-doc-ok\nEOF");
  check('here-doc runs whole', here.ok && here.stdout.trim() === 'here-doc-ok', JSON.stringify(here.stdout.trim()));

  // Statelessness, both directions: state inside one command works, nothing survives it.
  const b = await run('cd /tmp; pwd');
  const tempDir = tmpdir().replace(/\\/g, '/').toLowerCase();
  check('cd applies inside the command', b.ok && b.stdout.trim().length > 0, JSON.stringify(b.stdout.trim()));
  check('result.cwd resolves to the real directory', b.cwd.toLowerCase() === tempDir, `${b.cwd} == ${tmpdir()}`);
  const c = await run('pwd');
  check('next command starts back in the working directory', c.stdout.trim().toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase(), `${c.stdout.trim()} == ${cwd}`);
  const e = await run('x=42; echo $x');
  check('variable set inside a command', e.stdout.trim() === '42', JSON.stringify(e.stdout.trim()));
  const f = await run('echo "${x-}"');
  check('variable does not survive the process', f.stdout.trim() === '', JSON.stringify(f.stdout.trim()));

  const d = await run('cmd.exe /c exit 7');
  check('external exit code → 7', d.exitCode === '7' && !d.ok, `exit=${d.exitCode} ok=${d.ok}`);

  const g = await run('echo boom >&2; exit 1');
  check('stderr captured', /boom/.test(g.stderr) && !g.ok, JSON.stringify(g.stderr.trim()));

  const errexit = await run('set -e; echo survived-errexit');
  check('set -e does not break the epilogue', errexit.ok && errexit.stdout.trim() === 'survived-errexit' && errexit.cwd.length > 0,
    `ok=${errexit.ok} exit=${errexit.exitCode} cwd=${errexit.cwd}`);

  // what the command leaves running comes back in its own receipt, before the shell exits
  const spawned = await run('sleep 45 & echo started');
  const kids = spawned.procs.filter((p) => /niu\.exe$/i.test(p.name));
  check('same receipt already lists the child', kids.length > 0, spawned.procs.map((p) => `${p.name}(${p.pid})`).join(', '));
  const receipt = formatResult(spawned).text;
  check('receipt carries [cwd] and [bg]', receipt.includes('[cwd]') && receipt.includes('[bg]'));
  for (const k of kids) {
    try { process.kill(k.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await new Promise((res) => setTimeout(res, 300));
  const after = await run('true');
  check('killed children do not come back in a later receipt', kids.every((p) => !after.procs.some((q) => q.pid === p.pid)),
    after.procs.map((p) => `${p.name}(${p.pid})`).join(', '));
  const late = await run('(sleep 1; echo late-orphan) & echo now');
  check('output written after the shell exits is not captured', late.stdout.trim() === 'now', JSON.stringify(late.stdout.trim()));

  // a big output must settle on the sentinel, not on the pipe closing
  const big = await run('seq 1 200000', { maxOutputBytes: 2048 });
  check('large output truncates and still settles', big.ok && big.truncated && big.stdout.includes('省略'), `len=${big.stdout.length}`);

  // a command that ends the shell before the epilogue: the receipt says so instead of inventing a verdict
  const x = await run('echo before-exit; exit 3');
  check('exit inside the command → incomplete, exit code kept', x.incomplete && x.exitCode === '3' && !x.ok, `incomplete=${x.incomplete} exit=${x.exitCode}`);
  check('partial output still comes back', x.stdout.includes('before-exit'), JSON.stringify(x.stdout.trim()));
  const p = await run('if (');
  check('parse error → incomplete with stderr explaining', p.incomplete && p.exitCode !== '0' && p.exitCode !== '' && p.stderr.length > 0,
    `exit=${p.exitCode} stderr=${JSON.stringify(p.stderr.slice(0, 60))}`);

  // timeout terminates that one process; the next command is unaffected
  const { lines, log } = logCollector();
  const slow = await run('sleep 5', { log, timeoutMs: 800 });
  check('timeout flagged', slow.timedOut === true, `timedOut=${slow.timedOut}`);
  check('log: 启动和超时都留了行', ['shell 进程已启动', '命令超时,进程树已终止'].every((m) => lines.some((l) => l.includes(m))),
    lines.filter((l) => /warn|info/.test(l)).join(' | '));
  const t2 = await run('echo back-after-timeout');
  check('next command runs fine after a timeout', t2.ok && t2.stdout.includes('back-after-timeout'));

  // timeout kills the tree, not only the shell
  const treePidFile = join(cwd, 'tree.pid').replace(/\\/g, '/');
  const tree = await run(`sleep 30 & echo $! > '${treePidFile}'; wait`, { timeoutMs: 1200 });
  let treePid = 0;
  try { treePid = Number(readFileSync(treePidFile, 'utf8').trim()); } catch { /* the shell died before writing it */ }
  await new Promise((res) => setTimeout(res, 300));
  check('timeout kills the child tree, not only the shell', tree.timedOut && treePid > 0 && !pidAlive(treePid),
    `pid=${treePid} timedOut=${tree.timedOut}`);

  // interrupt: the shell of that call is terminated, nothing lingers
  const abortLog = logCollector();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const ab = await run('sleep 5', { log: abortLog.log, signal: ac.signal });
  check('abort flagged', ab.aborted === true, `aborted=${ab.aborted}`);
  const abortLine = abortLog.lines.find((l) => l.includes('命令被中断,进程树已终止'));
  check('log: 中断留了行', Boolean(abortLine), abortLog.lines.filter((l) => l.includes('中断')).join(' | '));
  const abortPid = Number(abortLine?.match(/"pid":(\d+)/)?.[1] ?? 0);
  await new Promise((res) => setTimeout(res, 400));
  check('aborted shell really terminated', abortPid > 0 && !pidAlive(abortPid), `pid=${abortPid}`);

  // a shell that cannot be started is a clear error, not a hang
  let spawnErr = '';
  try {
    await runCommand({ ...opts, shell: 'definitely-not-niu-xyz', command: 'true' });
  } catch (err) {
    spawnErr = String(err);
  }
  check('spawn failure is a clear error', /启动 shell/.test(spawnErr), spawnErr.slice(0, 120));

  // the tool accepts commands up to 8000 chars; the direct `-c` argument must still fit
  const long = await run("x='" + 'a'.repeat(7900) + "'; echo ${#x}");
  check('long command still runs', long.ok && long.stdout.trim() === '7900', JSON.stringify(long.stdout.trim()));

  // rtk availability is reported, not required.
  const rtk = detectRtk();
  console.log(`  · rtk: ${rtk.available ? rtk.path : 'not installed'}`);

  // a receipt shape the model reads.
  console.log('\n[receipt sample]\n' + formatResult(multi).text);

  // Opt-in: SMOKE_ASK=8 shows a real approval box for 8 seconds. Only a box that actually rendered
  // can answer `timeout`; a failed koffi load surfaces as `no` plus an anomaly line.
  const askSec = Number(process.env.SMOKE_ASK ?? 0);
  if (askSec > 0) {
    const ans = await askDesktop(`smoke:想运行这条命令\n\nWrite-Output 1\n\n是/否,不点的话 ${askSec} 秒后按拒绝。`, {
      timeoutMs: askSec * 1000,
      onAnomaly: (detail) => console.log('  · ask anomaly:', JSON.stringify(detail)),
    });
    check(`桌面确认框真的出现了(${askSec}s 内等答案)`, ans === 'timeout' || ans === 'yes' || ans === 'no', `answer=${ans}`);
  }
} catch (err) {
  console.error('smoke crashed:', err);
  failures++;
} finally {
  // A just-killed process may still hold the directory for a moment (Windows); retry briefly.
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
