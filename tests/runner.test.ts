import { describe, it, expect } from 'vitest';
import {
  BoundedLog, buildScript, buildPwshScript, parseNiuVersion, parsePowerShellVersion, parseProcLine,
  shellKind, splitSentinel, stripAnsi, normalizeEol, truncateBytes, runCommand, MAX_SCRIPT_CHARS,
  type RunResult,
} from '../src/runner.ts';
import { formatResult } from '../src/world.ts';

const base: RunResult = {
  stdout: '', stderr: '', ok: true, exitCode: '0', cwd: '', procs: [],
  timedOut: false, aborted: false, incomplete: false, truncated: false,
};

describe('splitSentinel', () => {
  const m = '__CSH_1_ab__';
  const pm = '__CSH_P_1__';
  it('returns null until the sentinel line is complete', () => {
    expect(splitSentinel(`hi\n${m}`, m, pm)).toBeNull();
    expect(splitSentinel('no marker here', m, pm)).toBeNull();
  });
  it('splits output and exit code at the sentinel', () => {
    const r = splitSentinel(`out1\nout2\n${m}|7|D:/p\n`, m, pm)!;
    expect(r.stdout).toBe('out1\nout2');
    expect(r.exitCode).toBe('7');
    expect(r.cwd).toBe('D:/p');
  });
  it('lifts the trailing snapshot rows out of the output', () => {
    const r = splitSentinel(`out\n\n${pm}18244 9911 node.exe node server.js\n${pm}9911 18244 cmd.exe ping x\n${m}|0|D:/p\n`, m, pm)!;
    expect(r.stdout).toBe('out');
    expect(r.procs).toEqual([
      { pid: 18244, name: 'node.exe', cmd: 'node server.js' },
      { pid: 9911, name: 'cmd.exe', cmd: 'ping x' },
    ]);
  });
  it('keeps output that lacks a trailing newline, with and without rows', () => {
    expect(splitSentinel(`tail\n${m}|0|\n`, m, pm)!.stdout).toBe('tail');
    expect(splitSentinel(`tail\n\n${pm}7 1 x.exe\n${m}|0|\n`, m, pm)!.stdout).toBe('tail');
  });
  it('keeps the user trailing newlines, minus the one the epilogue adds', () => {
    expect(splitSentinel(`a\n\n\n${m}|0|\n`, m, pm)!.stdout).toBe('a\n');
    expect(splitSentinel(`a\n\n\n${pm}7 1 x.exe\n${m}|0|\n`, m, pm)!.stdout).toBe('a\n');
  });
  it('drops unparseable snapshot rows without losing the output', () => {
    const r = splitSentinel(`x\n\n${pm}oops\n${m}|0|\n`, m, pm)!;
    expect(r.procs).toEqual([]);
    expect(r.stdout).toBe('x');
  });
  it('uses the last marker, so an earlier marker-shaped line is just output', () => {
    const r = splitSentinel(`early\n${m}|9|D:/fake\nreal\n${m}|0|D:/real\n`, m, pm)!;
    expect(r.exitCode).toBe('0');
    expect(r.cwd).toBe('D:/real');
    expect(r.stdout).toContain('real');
  });
});

describe('parseProcLine', () => {
  it('reads pid/name/cmd and drops junk or pid 0', () => {
    expect(parseProcLine('18244 9911 node.exe node server.js')).toEqual({ pid: 18244, name: 'node.exe', cmd: 'node server.js' });
    expect(parseProcLine('18244 9911 node.exe')).toEqual({ pid: 18244, name: 'node.exe', cmd: '' });
    expect(parseProcLine('0 0 [System Process] [System Process]')).toBeNull();
    expect(parseProcLine('garbage')).toBeNull();
    expect(parseProcLine('')).toBeNull();
  });
});

describe('normalizeEol', () => {
  it('collapses CRLF/CR and the trailing newline', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc');
  });
});

describe('stripAnsi', () => {
  it('removes SGR colour codes', () => {
    expect(stripAnsi('\u001b[31;1mfail: \u001b[0mboom')).toBe('fail: boom');
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('truncateBytes', () => {
  it('leaves short text untouched', () => {
    expect(truncateBytes('short', 100)).toBeNull();
  });
  it('keeps head and tail past the cap and reports the omitted bytes', () => {
    const r = truncateBytes('x'.repeat(1000), 100)!;
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('省略');
    expect(r.omitted).toBe(1000 - 100);
  });
});

describe('BoundedLog', () => {
  it('keeps everything under the cap', () => {
    const log = new BoundedLog(5, 5, 0);
    log.push('abcdefghij');
    expect(log.text()).toBe('abcdefghij');
    expect(log.truncated).toBe(false);
  });

  it('drops the middle once the cap is crossed and keeps the newest tail', () => {
    const log = new BoundedLog(5, 5, 0);
    log.push('abcdefghij');
    log.push('klmno');
    expect(log.text()).toBe('abcdeklmno');
    expect(log.truncated).toBe(true);
    log.push('p');
    expect(log.text()).toBe('abcdelmnop');
  });
});

describe('parseNiuVersion', () => {
  it('reads the first line of niu --version', () => {
    const raw = 'Niubash 1.3.3 — bash-compatible shell for Windows\n  rubash   git 646237e93532\n  winuxcmd WinuxCmd 1.1.5';
    expect(parseNiuVersion(raw)).toEqual({ version: 'Niubash 1.3.3', major: 1 });
  });
  it('rejects other shells and junk', () => {
    expect(parseNiuVersion('Windows PowerShell 5.1.19041.1')).toBeNull();
    expect(parseNiuVersion('command not found')).toBeNull();
  });
});

describe('shell dialect', () => {
  it('pwsh and powershell are PowerShell; niu is bash', () => {
    expect(shellKind('pwsh')).toBe('pwsh');
    expect(shellKind('pwsh.exe')).toBe('pwsh');
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
    expect(shellKind('powershell')).toBe('pwsh');
    expect(shellKind('niu')).toBe('bash');
    expect(shellKind('C:/niubash/niu.exe')).toBe('bash');
  });

  it('reads the PSVersion output', () => {
    expect(parsePowerShellVersion('7.6.7\r\n')).toEqual({ version: 'PowerShell 7.6.7', major: 7 });
    expect(parsePowerShellVersion('junk')).toBeNull();
  });
});

describe('buildScript', () => {
  const script = buildScript('echo hi', '__M__', '__P__');
  it('puts the command first and captures $? immediately after it', () => {
    expect(script.startsWith('echo hi\n__csh_ec=$?\n')).toBe(true);
  });
  it('turns errexit off after capturing $?, so the epilogue always runs', () => {
    expect(script).toContain('__csh_ec=$?\nset +e\n');
  });
  it('settles the physical cwd before the snapshot', () => {
    expect(script).toContain('cd -P .');
    expect(script.indexOf('__csh_ec=')).toBeLessThan(script.indexOf('cd -P .'));
  });
  it('snapshots direct children by ppid, minus the console host and the snapshot itself', () => {
    expect(script).toContain('ps -e -o pid,ppid,comm,args --no-headers');
    expect(script).toContain('[ "$__csh_ppid" = "$$" ]');
    expect(script).toContain('conhost.exe|ps.exe');
  });
  it('ends with the sentinel carrying the exit code and $PWD', () => {
    const last = script.split('\n').at(-1)!;
    expect(last).toContain("__M__|%s|%s");
    expect(last).toContain('"$__csh_ec"');
    expect(last).toContain('"$PWD"');
  });
});

describe('buildPwshScript', () => {
  const script = buildPwshScript('Write-Output hi', '__M__', '__P__');
  it('sets UTF-8, runs the command, then captures $? before anything else', () => {
    expect(script).toContain('[Console]::OutputEncoding');
    expect(script).toContain('Write-Output hi');
    expect(script.indexOf('Write-Output hi')).toBeLessThan(script.indexOf('$__csh_ok = $?'));
  });
  it('captures LASTEXITCODE and resets error/strict preferences for the epilogue', () => {
    expect(script).toContain('$__csh_last = $LASTEXITCODE');
    expect(script).toContain('$ErrorActionPreference = "Continue"');
    expect(script).toContain('Set-StrictMode -Off');
  });
  it('snapshots direct children through CIM minus the console host', () => {
    expect(script).toContain('Get-CimInstance -ClassName Win32_Process');
    expect(script).toContain("ParentProcessId=$PID");
    expect(script).toContain("Name!='conhost.exe'");
  });
  it('ends with the same sentinel shape as the bash dialect', () => {
    const last = script.split('\n').at(-1)!;
    expect(last).toContain('"__M__|$__csh_exit|$__csh_cwd"');
  });
});

describe('runCommand guard', () => {
  it('refuses a command whose script would not fit a Windows command line', async () => {
    await expect(runCommand({
      shell: 'niu', cwd: '', command: 'a'.repeat(MAX_SCRIPT_CHARS), timeoutMs: 1_000, maxOutputBytes: 1_000,
    })).rejects.toThrow(/命令太长/);
  });
});

describe('formatResult', () => {
  it('marks a clean command ok without failed', () => {
    const r = formatResult({ ...base, stdout: 'hello' });
    expect(r.text).toContain('[ok] exit=0');
    expect(r.text).toContain('hello');
    expect(r.failed).toBeUndefined();
  });
  it('stays quiet when there is no directory or child to report', () => {
    const r = formatResult({ ...base, stdout: 'hello' });
    expect(r.text).not.toContain('[cwd]');
    expect(r.text).not.toContain('[bg]');
  });
  it('flags a failed command and appends stderr', () => {
    const r = formatResult({ ...base, ok: false, exitCode: '1', stderr: 'boom' });
    expect(r.failed).toBe(true);
    expect(r.text).toContain('[fail] exit=1');
    expect(r.text).toContain('[stderr]');
    expect(r.text).toContain('boom');
  });
  it('does not mark a timeout as a failed command', () => {
    const r = formatResult({ ...base, ok: false, timedOut: true, stdout: 'partial' });
    expect(r.failed).toBeUndefined();
    expect(r.text).toContain('[timeout]');
  });
  it('does not mark an interrupted run as a failed command', () => {
    const r = formatResult({ ...base, ok: false, aborted: true, stdout: 'partial' });
    expect(r.failed).toBeUndefined();
    expect(r.text).toContain('[interrupted]');
  });
  it('says what is missing from an incomplete receipt', () => {
    const r = formatResult({ ...base, ok: false, incomplete: true, exitCode: '3', stdout: 'before' });
    expect(r.failed).toBe(true);
    expect(r.text).toContain('[incomplete]');
    expect(r.text).toContain('exit=3');
    expect(r.text).toContain('before');
  });
  it('accepts an incomplete receipt that exited 0', () => {
    const r = formatResult({ ...base, ok: true, incomplete: true, exitCode: '0' });
    expect(r.failed).toBeUndefined();
    expect(r.text).toContain('[incomplete]');
  });
});
