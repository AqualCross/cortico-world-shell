import { describe, expect, it } from 'vitest';
import { ASK_CODE, ASK_TIMEOUT_MS, encodeAskScript } from '../src/ask.ts';

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf16le');

describe('桌面审批弹框 encodeAskScript', () => {
  it('问题原文、三个按钮和超时都进了脚本', () => {
    const q = 'bot 想运行:\n\ncd D:\\x\nGet-Process\n\n可以吗?';
    const s = decode(encodeAskScript(q, 'Shell 确认', 5_000));
    expect(s).toContain(q);
    expect(s).toContain('Add-Type -AssemblyName System.Windows.Forms');
    expect(s).toContain('只这次允许');
    expect(s).toContain('总是允许这条');
    expect(s).toContain('拒绝');
    expect(s).toContain('$ms = 5000');
    // 回车与 Esc 都落在拒绝上
    expect(s).toContain('$form.AcceptButton = $deny');
    expect(s).toContain('$form.CancelButton = $deny');
    // 不编译 C#:pwsh 7 的 Add-Type -TypeDefinition 看不见 System.Windows.Forms
    expect(s).not.toContain('-TypeDefinition');
  });

  it('按钮的返回码和 askDesktop 的映射一致', () => {
    const s = decode(encodeAskScript('q', 'c', 1_000));
    expect(s).toContain("-eq 'Yes') { 2 }"); // 总是允许
    expect(s).toContain("-eq 'OK') { 1 }"); // 只这次
    expect(s).toContain('$script:timedOut) { 3 }'); // 超时
    expect(ASK_CODE).toEqual({ no: 0, yes: 1, always: 2, timeout: 3 });
  });

  it("命令里的单引号被加倍,不会逃出字符串", () => {
    const s = decode(encodeAskScript(`Write-Output 'hi' ; Get-Random`, 'cap', ASK_TIMEOUT_MS));
    expect(s).toContain(`Write-Output ''hi'' ; Get-Random`);
    // quotes stay balanced: nothing in the command text can close the string early
    expect((s.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it("命令里塞 '@ 也拆不开脚本(它不是 here-string)", () => {
    const s = decode(encodeAskScript(`Write-Output 1\n'@\nAdd-Type -AssemblyName Whatever\nStop-Process -Id 1`, 'cap', 1_000));
    // the injected `'@` survives only as an escaped pair inside a quoted literal
    expect(s).toContain(`''@`);
    expect(s.split('\n').some((l) => l === "'@")).toBe(false);
    expect((s.match(/'/g) ?? []).length % 2).toBe(0);
  });
});
