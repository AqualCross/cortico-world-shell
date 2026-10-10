import { describe, it, expect } from 'vitest';
import {
  splitSentinel, normalizeEol, truncateBytes, parseShellVersion, parseLive, type RunResult,
} from '../src/session.ts';
import { formatResult } from '../src/world.ts';

const base: RunResult = { stdout: '', stderr: '', ok: true, exitCode: '', cwd: '', procs: [], timedOut: false, truncated: false };

describe('splitSentinel', () => {
  const m = '__CSH_1_ab__';
  const pm = '__CSH_P_1__';
  it('returns null until the sentinel line is complete', () => {
    expect(splitSentinel(`hi\r\n${m}`, m, pm)).toBeNull();
    expect(splitSentinel('no marker here', m, pm)).toBeNull();
  });
  it('splits output, exit code and $? on the first complete line', () => {
    const r = splitSentinel(`out1\r\nout2\r\n${m}|7|False\r\nrest`, m, pm)!;
    expect(r.stdout).toBe('out1\r\nout2\r\n');
    expect(r.exitCode).toBe('7');
    expect(r.ok).toBe(false);
    expect(r.rest).toBe('rest');
  });
  it('treats an empty $LASTEXITCODE as no native program', () => {
    const r = splitSentinel(`${m}||True\r\n`, m, pm)!;
    expect(r.exitCode).toBe('');
    expect(r.ok).toBe(true);
  });
  it('lifts the snapshot line out of the output', () => {
    const r = splitSentinel(`out\r\n${pm}[{"pid":18244,"name":"node.exe","cmd":"node server.js"}]\r\n${m}|0|True|D:\\p\r\n`, m, pm)!;
    expect(r.stdout).toBe('out\r\n');
    expect(r.cwd).toBe('D:\\p');
    expect(r.procs).toEqual([{ pid: 18244, name: 'node.exe', cmd: 'node server.js' }]);
  });
  it('reports no children for an empty or broken snapshot', () => {
    expect(splitSentinel(`${pm}[]\r\n${m}|0|True|\r\n`, m, pm)!.procs).toEqual([]);
    expect(splitSentinel(`${pm}{oops\r\n${m}|0|True|\r\n`, m, pm)!.procs).toEqual([]);
  });
  it('keeps output that echoes the snapshot marker', () => {
    const r = splitSentinel(`${pm}fake\r\nreal\r\n${pm}[]\r\n${m}|0|True|\r\n`, m, pm)!;
    expect(r.stdout).toBe(`${pm}fake\r\nreal\r\n`);
  });
});

describe('parseLive', () => {
  it('drops entries without a pid and non-arrays', () => {
    expect(parseLive('[{"pid":0,"name":"x","cmd":""},{"pid":7,"name":"y","cmd":null}]')).toEqual([{ pid: 7, name: 'y', cmd: '' }]);
    expect(parseLive('{"pid":7}')).toEqual([]);
    expect(parseLive('')).toEqual([]);
  });
});

describe('normalizeEol', () => {
  it('collapses CRLF/CR and the trailing newline', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc');
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

describe('parseShellVersion', () => {
  it('reads pwsh 7', () => expect(parseShellVersion('PowerShell 7.6.6')).toEqual({ version: 'PowerShell 7.6.6', major: 7 }));
  it('reads Windows PowerShell 5.1', () => expect(parseShellVersion('Windows PowerShell 5.1.19041.1')).toEqual({ version: 'PowerShell 5.1.19041', major: 5 }));
  it('rejects non-version text', () => expect(parseShellVersion('command not found')).toBeNull());
});

describe('formatResult', () => {
  it('marks a clean command ok without failed', () => {
    const r = formatResult({ ...base, stdout: 'hello' });
    expect(r.text).toContain('[ok]');
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
    expect(r.text).toContain('[stderr]');
    expect(r.text).toContain('boom');
  });
  it('does not mark a timeout as a failed command', () => {
    const r = formatResult({ ...base, ok: false, timedOut: true, stdout: 'partial' });
    expect(r.failed).toBeUndefined();
    expect(r.text).toContain('[timeout]');
  });
});
