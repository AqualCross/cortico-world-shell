import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ALLOW_CAP, addAllow, matchAllow, normalizeCommand, readAllow } from '../src/allow.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'shell-allow-'));

describe('免询问名单', () => {
  it('比对只看首尾空白与换行风格', () => {
    expect(normalizeCommand('  a\r\nb \n')).toBe('a\nb');
    expect(matchAllow(['a\nb'], '  a\r\nb  ')?.entry).toBe('a\nb');
    expect(matchAllow(['a b'], 'a b -s')).toBeNull();  // 多个参数是另一条命令
    expect(matchAllow(['git*'], 'git push')).toBeNull(); // 没有通配
    expect(matchAllow([''], 'x')).toBeNull();
    expect(matchAllow(['x'], '   ')).toBeNull();
  });

  it('没有文件、坏文件、坏内容都当作名单为空', () => {
    const dir = scratch();
    try {
      expect(readAllow(join(dir, 'none.json'))).toEqual([]);
      const file = join(dir, 'allow.json');
      for (const bad of ['not json', '{"a":1}', '[1,2]', '[null,"",{}]', '[]']) {
        writeFileSync(file, bad, 'utf8');
        expect(readAllow(file), bad).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('记一条、去重、封顶,写出来是人能改的 JSON 数组', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'nested', 'allowlist.json');
      const first = addAllow(file, '  git status\r\n');
      expect(first).toMatchObject({ ok: true, reason: 'added' });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['git status']);
      // 同一条命令(空白不同)不重复记
      const dup = addAllow(file, 'git status');
      expect(dup.ok).toBe(true);
      expect(dup.reason).toBe('already');
      expect(dup.entries).toEqual(['git status']);
      expect(matchAllow(readAllow(file), 'git status')?.entry).toBe('git status');
      // 满员不再收
      writeFileSync(file, JSON.stringify(Array.from({ length: ALLOW_CAP }, (_, i) => `cmd${i}`)), 'utf8');
      const full = addAllow(file, 'one more');
      expect(full.ok).toBe(false);
      expect(full.reason).toContain('名单已满');
      expect(readAllow(file).length).toBe(ALLOW_CAP);
      // 空命令不收
      mkdirSync(join(dir, 'empty'), { recursive: true });
      expect(addAllow(join(dir, 'empty'), 'x').ok).toBe(false);
      expect(addAllow(file, '   ').reason).toBe('命令是空的');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
