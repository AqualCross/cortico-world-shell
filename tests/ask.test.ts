import { describe, expect, it } from 'vitest';
import { ASK_TIMEOUT_MS, MSGBOX, displayText, mapMessageBoxResult } from '../src/ask.ts';

describe('原生确认框的答案映射', () => {
  it('只有明确的 IDYES 算同意', () => {
    expect(mapMessageBoxResult(MSGBOX.yes)).toBe('yes');
    expect(mapMessageBoxResult(MSGBOX.no)).toBe('no');
    expect(mapMessageBoxResult(MSGBOX.timeout)).toBe('timeout');
    expect(mapMessageBoxResult(0)).toBe('no'); // 认不出的值一律按拒绝
    expect(mapMessageBoxResult(-1)).toBe('no');
  });

  it('常量与 winuser.h 对齐', () => {
    expect(MSGBOX).toEqual({ yes: 6, no: 7, timeout: 32000 });
  });

  it('默认给足 60 秒', () => {
    expect(ASK_TIMEOUT_MS).toBe(60_000);
  });
});

describe('审批框里的文本', () => {
  it('折叠换行、保留制表符', () => {
    expect(displayText('a\r\nb\tc')).toBe('a\nb\tc');
  });

  it('把双向控制符和零宽字符转成可见转义', () => {
    const shown = displayText('safe \u202Eevil\u202C end');
    expect(shown).toBe('safe \\u202Eevil\\u202C end');
    expect(displayText('a\u200Bb')).toBe('a\\u200Bb');
  });

  it('其他控制符也转义,孤独的回车不落成换行', () => {
    expect(displayText('a\rb')).toBe('a\\u000Db');
    expect(displayText('a\u0000b')).toBe('a\\u0000b');
  });
});
