/**
 * Real end-to-end check of the persistent PowerShell session. Run by hand:
 *   pnpm smoke
 * Not part of `pnpm test` (it spawns a real shell). Exits non-zero on the first failed assertion.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PwshSession } from '../src/session.ts';
import { formatResult } from '../src/world.ts';
import { askDesktop } from '../src/ask.ts';
import { readRecord, writeRecord } from '../src/claim.ts';
import { detectRtk } from '../src/rtk.ts';
import type { Logger } from 'cortico/core/types.ts';

const shell = process.env.SMOKE_SHELL ?? 'pwsh';
const session = new PwshSession({ shell, cwd: '' });
let failures = 0;
const check = (label: string, cond: boolean, extra = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};
const opts = { timeoutMs: 15_000, maxOutputBytes: 24_000 };

/** Collects the lifecycle lines a real session writes, so the audit trail is checked, not assumed. */
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

try {
  const a = await session.run('Write-Output "hello-smoke"', opts);
  check('plain Write-Output', a.ok && a.stdout.includes('hello-smoke'), JSON.stringify(a.stdout.trim()));
  check('empty exit for cmdlet', a.exitCode === '' || /^\d+$/.test(a.exitCode), `exit=${a.exitCode}`);
  check('no console-host noise in the snapshot', !a.procs.some((p) => /conhost/i.test(p.name)), a.procs.map((p) => p.name).join(', '));

  const b = await session.run('Set-Location $env:TEMP; (Get-Location).Path', opts);
  check('cd took effect', b.ok && /^[A-Z]:[\\/]/i.test(b.stdout.trim()), b.stdout.trim());
  const c = await session.run('(Get-Location).Path', opts);
  check('cwd survives to next call', c.stdout.trim() === b.stdout.trim(), `${c.stdout.trim()} == ${b.stdout.trim()}`);

  const d = await session.run('cmd /c exit 7', opts);
  check('native exit code → 7', d.exitCode === '7' && !d.ok, `exit=${d.exitCode} ok=${d.ok}`);

  const e = await session.run('$global:smokeVar = 42; $smokeVar', opts);
  check('variable set', e.stdout.includes('42'));
  const f = await session.run('$smokeVar * 2', opts);
  check('variable persists across calls', f.stdout.includes('84'), f.stdout.trim());

  const g = await session.run('Write-Error "boom"', opts);
  check('stderr captured', /boom/.test(g.stderr) && !g.ok, JSON.stringify(g.stderr.trim()));

  // what the bot leaves running must come back to it without asking
  const spawned = await session.run(
    `Start-Process -FilePath '${shell}' -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 20' -WindowStyle Hidden`,
    opts,
  );
  check('Start-Process itself ok', spawned.ok, `exit=${spawned.exitCode}`);
  const snap = await session.run('1', opts);
  const kids = snap.procs.filter((p) => /pwsh|powershell/i.test(p.name));
  check('snapshot lists the child', kids.length > 0, snap.procs.map((p) => `${p.name}(${p.pid})`).join(', '));
  check('cwd comes back without asking', /^[A-Z]:[\\/]/i.test(snap.cwd), snap.cwd);
  check('status reports the same list', session.status().procs.length === snap.procs.length);
  const receipt = formatResult(snap).text;
  check('receipt carries [cwd] and [bg]', receipt.includes('[cwd]') && receipt.includes('[bg]'));
  if (kids.length) {
    const ids = kids.map((p) => p.pid).join(',');
    await session.run(`Stop-Process -Id ${ids} -Force -ErrorAction SilentlyContinue`, opts);
    const after = await session.run('1', opts);
    check('snapshot drops processes that exited', kids.every((p) => !after.procs.some((q) => q.pid === p.pid)));
  }

  // rtk availability is reported, not required.
  const rtk = detectRtk();
  console.log(`  · rtk: ${rtk.available ? rtk.version || rtk.path : 'not installed'}`);

  // timeout kills the session and a later call restarts cleanly.
  const { lines, log } = logCollector();
  const slow = new PwshSession({ shell, cwd: '', log });
  const t = await slow.run('Start-Sleep -Seconds 5', { ...opts, timeoutMs: 800 });
  check('timeout flagged', t.timedOut === true, `timedOut=${t.timedOut}`);
  const t2 = await slow.run('Write-Output "back-after-restart"', opts);
  check('session auto-restarted after timeout', t2.ok && t2.stdout.includes('back-after-restart'));
  check('log: 启动和超时都留了行', ['pwsh 会话已启动', '命令未完成,会话已丢弃']
    .every((m) => lines.some((l) => l.includes(m))), lines.filter((l) => /warn|info/.test(l)).join(' | '));
  await slow.dispose();
  check('log: 关闭留了行', lines.some((l) => l.includes('会话已关闭')));

  // a session thrown away while its children still run must say so
  const loud = logCollector();
  const leak = new PwshSession({ shell, cwd: '', log: loud.log });
  await leak.run(`Start-Process -FilePath '${shell}' -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 8' -WindowStyle Hidden`, opts);
  const still = await leak.run('1', opts);
  await leak.dispose();
  check('log: 遗留进程被点名', loud.lines.some((l) => l.includes('它起的进程仍在运行')),
    still.procs.map((p) => `${p.name}(${p.pid})`).join(', '));

  // a death we did not cause must still be reported (the identity guard must not swallow it)
  const quiet = logCollector();
  const dying = new PwshSession({ shell, cwd: '', log: quiet.log });
  await dying.run('Write-Output 1', opts);
  const gone = await dying.run('Stop-Process -Id $PID', opts);
  check('self-kill ends the wait instead of hanging', gone.timedOut === true);
  check('log: 非本包所为的退出被记下', quiet.lines.some((l) => l.includes('pwsh 会话进程结束')),
    quiet.lines.filter((l) => l.includes('进程结束')).join(' | '));
  await dying.dispose();

  // a receipt shape the model reads.
  console.log('\n[receipt sample]\n' + formatResult(a).text);

  // ---- 上一代崩了留下的 pwsh,新一代要认领清掉 ----
  const dir = mkdtempSync(join(tmpdir(), 'cortico-shell-'));
  const stateFile = join(dir, 'session.json');
  /** Is that pid still a process? */
  const pidAlive = (pid: number): boolean => {
    const r = spawnSync(shell, ['-NoProfile', '-Command',
      `if (Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return String(r.stdout).includes('alive');
  };
  // The state a claim has to act on: a pwsh with our own argument signature, recorded as our
  // predecessor's session, blocked in a native command of its own. How a session gets orphaned is a
  // matter for the README (killing the owner normally takes the shell down through stdin EOF); what
  // matters here is that the next generation recognises it, kills only it, and names its command.
  const leftover = spawn(shell, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  // `timeout` refuses a redirected stdin and exits at once, so the hold is a ping.
  leftover.stdin?.write(`Set-Location $env:TEMP; & $env:ComSpec /c "ping -n 20 127.0.0.1 >nul"\n`);
  const leaked = leftover.pid ?? 0;
  writeRecord(stateFile, { pid: leaked, startedMs: Date.now(), shell, cwd: '' });
  await new Promise((res) => setTimeout(res, 2_000));
  check('留下的会话确实活着', leaked > 0 && pidAlive(leaked), `pid=${leaked}`);
  check('它把自己登记进了 stateFile', readRecord(stateFile)?.pid === leaked, stateFile);

  const claimLog = logCollector();
  const next = new PwshSession({ shell, cwd: '', log: claimLog.log, stateFile });
  await next.run('Write-Output "new generation"', opts);
  check('新一代开会话时清掉了它', !pidAlive(leaked), `pid=${leaked}`);
  check('log: 认领留了行,并点名它手里还挂着的命令',
    claimLog.lines.some((l) => l.includes('清掉了上一代遗留的 PowerShell 会话') && /cmd\.exe/.test(l)),
    claimLog.lines.filter((l) => l.includes('上一代')).join(' | '));
  check('新一代轮到自己被登记', readRecord(stateFile)?.pid === next.status().pid);
  await next.dispose();
  check('正常关闭后不留待认领的记录', readRecord(stateFile) === null);

  // A reused pid is not our predecessor: it must survive the claim untouched.
  const stranger = join(dir, 'stranger.json');
  writeFileSync(stranger, JSON.stringify({ pid: process.pid, startedMs: Date.now(), shell, cwd: '' }), 'utf8');
  const guardLog = logCollector();
  const guarded = new PwshSession({ shell, cwd: '', log: guardLog.log, stateFile: stranger });
  await guarded.run('Write-Output 1', opts);
  check('不是我们的进程绝不碰', pidAlive(process.pid) && guardLog.lines.some((l) => l.includes('没认领') && l.includes('not-ours')),
    guardLog.lines.filter((l) => l.includes('上一代')).join(' | '));
  await guarded.dispose();
  rmSync(dir, { recursive: true, force: true });

  // Opt-in: SMOKE_ASK=8 shows a real approval box for 8 seconds. Only a box that actually rendered
  // can answer `timeout`; a failed Add-Type/spawn surfaces as `no`.
  const askSec = Number(process.env.SMOKE_ASK ?? 0);
  if (askSec > 0) {
    const ans = await askDesktop(`smoke:想运行这条命令\n\nWrite-Output 1\n\n三个按钮:只这次允许 / 总是允许这条 / 拒绝。回车与 Esc 都是拒绝。\n\n(不点的话 ${askSec} 秒后按拒绝)`, {
      shell, timeoutMs: askSec * 1000,
    });
    check(`桌面弹框真的出现了(${askSec}s 内等答案)`, ans === 'timeout' || ans === 'yes' || ans === 'always', `answer=${ans}`);
  }

  await session.dispose();
} catch (err) {
  console.error('smoke crashed:', err);
  failures++;
}

console.log(`\n${failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
