import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchAllow, normalizeCommand, readAllow } from '../src/allow.ts';

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

  it('名单文件是一个能直接读改的 JSON 数组', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'allowlist.json');
      writeFileSync(file, JSON.stringify(['git status', 'cargo test']), 'utf8');
      expect(readAllow(file)).toEqual(['git status', 'cargo test']);
      expect(matchAllow(readAllow(file), 'git status')?.entry).toBe('git status');
      expect(matchAllow(readAllow(file), 'git status -s')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
