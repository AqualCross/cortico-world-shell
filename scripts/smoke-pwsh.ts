/**
 * Real end-to-end check of the one-shot PowerShell runner. Run by hand:
 *   pnpm smoke:pwsh
 * Not part of `pnpm test` (it spawns real shells). Exits non-zero on the first failed assertion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, probePowerShell, type RunResult, type RunSpec } from '../src/runner.ts';
import { formatResult } from '../src/world.ts';
import type { Logger } from 'cortico/core/types.ts';

const shell = process.env.SMOKE_PWSH ?? 'pwsh';
const cwd = mkdtempSync(join(tmpdir(), 'cortico-shell-pwsh-'));
let failures = 0;
const check = (label: string, cond: boolean, extra = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};
const opts = { shell, cwd, timeoutMs: 15_000, maxOutputBytes: 24_000 };
const run = (command: string, extra: Partial<RunSpec> = {}): Promise<RunResult> => runCommand({ ...opts, command, ...extra });
const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase();

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  const version = probePowerShell(shell);
  check('pwsh 7 is available', version.ok && version.major >= 7, `${version.version} ${version.reason}`);

  const a = await run("Write-Output 'hello-pwsh'");
  check('plain output', a.ok && a.exitCode === '0' && a.stdout.includes('hello-pwsh'), JSON.stringify(a.stdout.trim()));

  const utf = await run("Write-Output '中文-测试'");
  check('UTF-8 output survives the pipe', utf.ok && utf.stdout.includes('中文-测试'), JSON.stringify(utf.stdout.trim()));

  const state = await run("$env:CSH_SMOKE='yes'; Set-Location $env:TEMP; Write-Output $env:CSH_SMOKE; (Get-Location).ProviderPath");
  check('state works inside one command', state.ok && state.stdout.includes('yes'), JSON.stringify(state.stdout.trim()));
  check('cwd resolves to the directory the command moved to', norm(state.cwd) === norm(tmpdir()), `${state.cwd} == ${tmpdir()}`);
  const fresh = await run('(Get-Location).ProviderPath');
  check('next command starts back in the working directory', norm(fresh.stdout.trim()) === norm(cwd), `${fresh.stdout.trim()} == ${cwd}`);
  const noState = await run('Write-Output "$($env:CSH_SMOKE)"');
  check('variables do not survive the process', noState.stdout.trim() === '', JSON.stringify(noState.stdout.trim()));

  const d = await run('cmd.exe /c exit 7');
  check('native exit code → 7', d.exitCode === '7' && !d.ok, `exit=${d.exitCode} ok=${d.ok}`);

  const g = await run("Write-Error 'boom'");
  check('stderr captured and $? fails', /boom/.test(g.stderr) && !g.ok && g.exitCode === '1', `exit=${g.exitCode} stderr=${JSON.stringify(g.stderr.trim().slice(0, 80))}`);

  const strict = await run("Set-StrictMode -Version Latest; Write-Output 'strict-ok'");
  check('epilogue survives StrictMode', strict.ok && strict.stdout.includes('strict-ok'), `incomplete=${strict.incomplete} exit=${strict.exitCode}`);

  const cmdlet = await run("Get-Item 'Z:\\definitely-missing-csh' -ErrorAction SilentlyContinue");
  check('cmdlet failure is a fail receipt', !cmdlet.ok && !cmdlet.incomplete, `incomplete=${cmdlet.incomplete} exit=${cmdlet.exitCode}`);

  const stop = await run("$ErrorActionPreference='Stop'; Get-Item 'Z:\\definitely-missing-csh'");
  check('terminating error → incomplete', stop.incomplete && !stop.ok, `incomplete=${stop.incomplete} exit=${stop.exitCode}`);

  const spawned = await run("$p = Start-Process -FilePath 'pwsh' -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 30' -PassThru; Write-Output $p.Id");
  const childPid = Number(spawned.stdout.trim().split(/\r?\n/).at(-1) ?? 0);
  check('same receipt already lists the child', spawned.ok && childPid > 0 && spawned.procs.some((p) => p.pid === childPid), `pid=${childPid} procs=${spawned.procs.map((p) => `${p.name}(${p.pid})`).join(', ')}`);
  const receipt = formatResult(spawned).text;
  check('receipt carries [cwd] and [bg]', receipt.includes('[cwd]') && receipt.includes('[bg]'));
  try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
  await new Promise((res) => setTimeout(res, 300));

  // timeout kills the tree, not only the shell
  const tree = await run("$p = Start-Process -FilePath 'pwsh' -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 30' -PassThru; Write-Output $p.Id; Start-Sleep -Seconds 30", { timeoutMs: 1500 });
  const treePid = Number(tree.stdout.trim().split(/\r?\n/).at(-1) ?? 0);
  await new Promise((res) => setTimeout(res, 300));
  check('timeout kills the child tree, not only the shell', tree.timedOut && treePid > 0 && !pidAlive(treePid), `pid=${treePid} timedOut=${tree.timedOut}`);

  const { lines, log } = logCollector();
  const slow = await run('Start-Sleep -Seconds 5', { log, timeoutMs: 800 });
  check('timeout flagged', slow.timedOut === true, `timedOut=${slow.timedOut}`);
  check('log: start and timeout lines', ['shell 进程已启动', '命令超时,进程树已终止'].every((m) => lines.some((l) => l.includes(m))),
    lines.filter((l) => /warn|info/.test(l)).join(' | '));

  const early = await run('Write-Output before-exit; exit 3');
  check('exit inside the command → incomplete, exit code kept', early.incomplete && early.exitCode === '3' && !early.ok, `incomplete=${early.incomplete} exit=${early.exitCode}`);

  const bad = await run('if (');
  check('parse error → incomplete with stderr explaining', bad.incomplete && bad.exitCode !== '0' && bad.exitCode !== '' && bad.stderr.length > 0,
    `exit=${bad.exitCode} stderr=${JSON.stringify(bad.stderr.slice(0, 80))}`);

  console.log('\n[receipt sample]\n' + formatResult(a).text);
} catch (err) {
  console.error('pwsh smoke crashed:', err);
  failures++;
} finally {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${failures === 0 ? 'PWSH SMOKE PASSED' : `PWSH SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
