import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimCommand, clearRecord, parseClaim, readRecord, writeRecord, CLAIM_MARKER } from '../src/claim.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'shell-claim-'));

describe('认领上一代遗留会话', () => {
  it('登记、读回、按 pid 清除', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'nested', 'session.json');
      expect(readRecord(file)).toBeNull(); // 没有文件就是没有可认领的
      writeRecord(file, { pid: 4242, startedMs: 1_700_000_000_000, shell: 'pwsh', cwd: 'C:\\x' });
      expect(readRecord(file)?.pid).toBe(4242);
      clearRecord(file, 999); // 不是自己的记录不动
      expect(readRecord(file)?.pid).toBe(4242);
      clearRecord(file, 4242);
      expect(readRecord(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('坏记录一律当作没有', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'session.json');
      for (const bad of ['not json', '{}', '{"pid":0,"startedMs":1}', '{"pid":"x","startedMs":1}', '{"pid":1.5,"startedMs":1}', '{"pid":1,"startedMs":null}']) {
        writeFileSync(file, bad, 'utf8');
        expect(readRecord(file), bad).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('认领脚本只带数字,命令文本里没有可拼接的东西', () => {
    const s = claimCommand(1234, 5678, 1_700_000_000_000);
    expect(s).toContain('ProcessId=1234 AND ProcessId != 5678');
    expect(s).toContain('ParentProcessId=1234');
    expect(s).toContain('Stop-Process -Id 1234');
    // start time ±10s
    expect(s).toContain(`${1_700_000_000_000 - 10_000}`);
    expect(s).toContain(`${1_700_000_000_000 + 10_000}`);
    expect(s).toContain(CLAIM_MARKER);
  });

  it('认领脚本每行都是完整语句(stdin 逐行解析,断句会把整段吞掉)', () => {
    const lines = claimCommand(1234, 5678, 1_700_000_000_000).split('\n');
    for (const l of lines) {
      expect(l.trim(), l).toMatch(/^[^}]/); // 没有以 } 开头的续行
      expect(l.trim(), l).not.toMatch(/^(else|elseif|catch|finally|do)\b/);
      expect((l.match(/\{/g) ?? []).length, l).toBe((l.match(/\}/g) ?? []).length);
    }
  });

  it('读得懂认领结果', () => {
    const out = `noise\n${CLAIM_MARKER}{"killed":true,"reason":"killed","kids":[{"pid":7,"name":"node.exe","cmd":"node s.js"}]}\n`;
    expect(parseClaim(out)).toEqual({ killed: true, reason: 'killed', kids: [{ pid: 7, name: 'node.exe', cmd: 'node s.js' }] });
    expect(parseClaim(`${CLAIM_MARKER}{"killed":false,"reason":"not-ours","kids":[]}`)).toEqual({ killed: false, reason: 'not-ours', kids: [] });
    expect(parseClaim('no marker here').reason).toBe('no-claim-line');
    expect(parseClaim(`${CLAIM_MARKER}{broken`).reason).toBe('bad-json');
    // kids 不是数组也不能抛
    expect(parseClaim(`${CLAIM_MARKER}{"killed":false,"reason":"gone","kids":null}`).kids).toEqual([]);
  });

  it('单个 kid 也认得(Windows 有时把单元素数组写成对象)', () => {
    const r = parseClaim(`${CLAIM_MARKER}{"killed":true,"reason":"killed","kids":{"pid":9,"name":"pwsh.exe","cmd":"x"}}`);
    expect(r.kids).toEqual([{ pid: 9, name: 'pwsh.exe', cmd: 'x' }]);
    expect(r.killed).toBe(true);
  });
});
