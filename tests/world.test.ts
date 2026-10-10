import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { LiveProcess, RunOptions, RunResult, SessionStatus, ShellSession } from '../src/session.ts';
import type { Answer } from '../src/ask.ts';
import { ShellWorld, type ShellWorldOptions } from '../src/world.ts';
import { SHELL } from '../src/definition.ts';
import { SHELL_DEFAULTS, type AskLevel } from '../src/config.ts';

/** Records commands and replays canned results; never spawns PowerShell. */
class FakeSession implements ShellSession {
  commands: string[] = [];
  disposed = false;
  restarted = false;
  result: RunResult = { stdout: 'ok-output', stderr: '', ok: true, exitCode: '', cwd: '', procs: [], timedOut: false, truncated: false };
  procs: LiveProcess[] = [];
  status(): SessionStatus { return { running: !this.disposed, pid: this.disposed ? null : 4242, cwd: 'C:\\work', procs: this.procs }; }
  async start(): Promise<void> {}
  async run(command: string, _o: RunOptions): Promise<RunResult> { this.commands.push(command); return this.result; }
  async restart(): Promise<void> { this.restarted = true; }
  async dispose(): Promise<void> { this.disposed = true; }
}

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'shell-world-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

const call = {} as ToolCallContext;

function makeWorld(session: FakeSession, opts: Partial<ShellWorldOptions> = {}): { world: ShellWorld; tool: (name: string) => ToolDef } {
  const ctx = fakeWorldContext(SHELL, { scratchDir }) as { cfg: typeof SHELL_DEFAULTS; timezone: string };
  const world = new ShellWorld({
    cfg: { ...ctx.cfg }, timezone: ctx.timezone, defaultCwd: scratchDir,
    ask: async () => 'yes', createSession: () => session, ...opts,
  });
  return { world, tool: (name) => world.tools().find((t) => t.name === name)! };
}

describe('Shell World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    expect((await dryMountWorld(SHELL, { scratchDir })).failures).toEqual([]);
  });

  it('暴露 shell_run 与 shell_restart', () => {
    const { world } = makeWorld(new FakeSession());
    expect(world.tools().map((t) => t.name)).toEqual(['shell_run', 'shell_restart']);
  });

  it('shell_run 透传命令并渲染 ok 回执', async () => {
    const s = new FakeSession();
    const run = makeWorld(s).tool('shell_run');
    const res = (await run.handler({ command: 'Get-Date' }, call)) as ToolOutcome;
    expect(s.commands).toEqual(['Get-Date']);
    expect(res.text).toContain('[ok]');
    expect(res.text).toContain('ok-output');
    expect(res.failed).toBeUndefined();
  });

  it('shell_run 空命令直接失败,不碰会话', async () => {
    const s = new FakeSession();
    const run = makeWorld(s).tool('shell_run');
    const res = (await run.handler({ command: '   ' }, call)) as ToolOutcome;
    expect(res.failed).toBe(true);
    expect(s.commands).toEqual([]);
  });

  it('失败标 failed,超时不标 failed', async () => {
    const s = new FakeSession();
    const run = makeWorld(s).tool('shell_run');
    s.result = { ...s.result, stdout: '', ok: false, exitCode: '2' };
    expect(((await run.handler({ command: 'x' }, call)) as ToolOutcome).failed).toBe(true);
    s.result = { ...s.result, ok: false, exitCode: '', timedOut: true };
    expect(((await run.handler({ command: 'x' }, call)) as ToolOutcome).failed).toBeUndefined();
  });

  it('回执带 [cwd] 与 [bg],元信息排在输出前面', async () => {
    const s = new FakeSession();
    s.result = {
      ...s.result, cwd: 'D:\\project\\ts',
      procs: [{ pid: 18244, name: 'node.exe', cmd: 'node server.js' }],
    };
    const res = (await makeWorld(s).tool('shell_run').handler({ command: 'x' }, call)) as ToolOutcome;
    expect(res.text).toContain('[cwd] D:\\project\\ts');
    expect(res.text).toContain('[bg] node(18244)');
    expect(res.text.indexOf('[bg]')).toBeLessThan(res.text.indexOf('ok-output'));
  });

  it('shell_restart 说清旧会话遗留的进程', async () => {
    const s = new FakeSession();
    s.procs = [{ pid: 9911, name: 'python.exe', cmd: 'python -m http.server' }];
    const res = (await makeWorld(s).tool('shell_restart').handler({}, call)) as ToolOutcome;
    expect(res.text).toContain('1 个进程还在跑');
    expect(res.text).toContain('python(9911)');
  });

  it('环境提示词报告当前挂着的进程', async () => {
    const s = new FakeSession();
    const { world, tool } = makeWorld(s);
    expect(world.envPromptVars()['shell.processes']).toContain('会话尚未开启');
    await tool('shell_run').handler({ command: 'x' }, call); // builds the session
    s.procs = [{ pid: 18244, name: 'node.exe', cmd: 'node server.js' }];
    expect(world.envPromptVars()['shell.processes']).toContain('node(18244) node server.js');
  });

  it('控制台徽章显示进程数', async () => {
    const s = new FakeSession();
    const { world, tool } = makeWorld(s);
    const badge = (): string => String((world.console('zh').badges ?? []).find((b) => b.label === '它起的进程')!.value);
    expect(badge()).toBe('无'); // no session yet
    await tool('shell_run').handler({ command: 'x' }, call); // builds it
    expect(badge()).toBe('无');
    s.procs = [{ pid: 1, name: 'cmd.exe', cmd: '' }, { pid: 2, name: 'cmd.exe', cmd: '' }];
    expect(badge()).toBe('2 · cmd(1), cmd(2)');
  });

  it('起始目录不存在时先建出来', async () => {
    const target = join(scratchDir, 'shell-work', 'deep');
    const ctx = fakeWorldContext(SHELL, { scratchDir }) as { cfg: typeof SHELL_DEFAULTS; timezone: string };
    const world = new ShellWorld({
      cfg: { ...ctx.cfg, cwd: target }, timezone: ctx.timezone, defaultCwd: scratchDir,
      ask: async () => 'yes', createSession: () => new FakeSession(),
    });
    await world.tools()[0].handler!({ command: 'x' }, call);
    expect(existsSync(target)).toBe(true);
  });

  it('会话拿到认领记录的路径', async () => {
    const ctx = fakeWorldContext(SHELL, { scratchDir }) as { cfg: typeof SHELL_DEFAULTS; timezone: string };
    let seen: string | undefined;
    const world = new ShellWorld({
      cfg: { ...ctx.cfg }, timezone: ctx.timezone, defaultCwd: scratchDir,
      stateFile: join(scratchDir, 'shell', 'session.json'),
      ask: async () => 'yes',
      createSession: (o) => { seen = o.stateFile; return new FakeSession(); },
    });
    await world.tools()[0].handler!({ command: 'x' }, call);
    expect(seen).toBe(join(scratchDir, 'shell', 'session.json'));
  });

  it('shell_restart 重启会话', async () => {
    const s = new FakeSession();
    const restart = makeWorld(s).tool('shell_restart');
    const res = (await restart.handler({}, call)) as ToolOutcome;
    expect(s.restarted).toBe(true);
    expect(res.text).toContain('shell_restart');
  });

  it('stop 释放已建立的会话', async () => {
    const s = new FakeSession();
    const { world, tool } = makeWorld(s);
    await tool('shell_run').handler({ command: 'touch' }, call); // builds the session
    await world.stop();
    expect(s.disposed).toBe(true);
  });
});

describe('先问再跑 worlds.shell.ask', () => {
  function gated(level: AskLevel, answer: Answer, grantMinutes = 30, extra: Partial<ShellWorldOptions> = {}) {
    const s = new FakeSession();
    const asked: string[] = [];
    const world = new ShellWorld({
      cfg: { ...SHELL_DEFAULTS, ask: level, grantMinutes },
      timezone: 'Asia/Shanghai',
      defaultCwd: scratchDir,
      botName: 'Bot',
      ask: async (q) => { asked.push(q); return answer; },
      createSession: () => s,
      ...extra,
    });
    const run = (command: string) => world.tools().find((t) => t.name === 'shell_run')!.handler!({ command }, call) as Promise<ToolOutcome>;
    return { s, asked, world, run };
  }

  it('默认就是先问,不是不问', () => {
    expect(SHELL_DEFAULTS.ask).toBe('ask-each-turn');
  });

  it('弹窗里写清是谁要跑什么', async () => {
    const g = gated('ask-each-turn', 'yes');
    await g.run('Remove-Item -Recurse x:\\tmp');
    expect(g.asked[0]).toContain('Bot');
    expect(g.asked[0]).toContain('Remove-Item -Recurse x:\\tmp');
    expect(g.s.commands).toEqual(['Remove-Item -Recurse x:\\tmp']);
  });

  it('每轮问一次:同意后这一轮不再问', async () => {
    const g = gated('ask-each-turn', 'yes');
    await g.run('a');
    await g.run('b');
    expect(g.asked.length).toBe(1);
    expect(g.s.commands).toEqual(['a', 'b']);
  });

  it('每轮问一次:拒了就整轮不再问,也不执行', async () => {
    const g = gated('ask-each-turn', 'no');
    const first = await g.run('a');
    expect(first.failed).toBe(true);
    expect(first.text).toContain('[未执行]');
    expect(first.text).toContain('点了「拒绝」');
    const second = await g.run('b');
    expect(second.failed).toBe(true);
    expect(g.asked.length).toBe(1);
    expect(g.s.commands).toEqual([]);
    g.world.onTurnEnded();
    await g.run('c');
    expect(g.asked.length).toBe(2);
  });

  it('每条命令都问', async () => {
    const g = gated('ask-each-command', 'yes');
    await g.run('a');
    await g.run('b');
    expect(g.asked.length).toBe(2);
    expect(g.s.commands).toEqual(['a', 'b']);
  });

  it('问一次:同意后 grantMinutes 内不再问', async () => {
    const g = gated('ask-once', 'yes', 5);
    await g.run('a');
    await g.run('b');
    expect(g.asked.length).toBe(1);
  });

  it('没人理按不同意算,并说清是超时', async () => {
    const g = gated('ask-each-turn', 'timeout');
    const r = await g.run('a');
    expect(r.failed).toBe(true);
    expect(r.text).toContain('没人理');
    expect(g.s.commands).toEqual([]);
  });

  it('never-ask 不打扰人', async () => {
    const g = gated('never-ask', 'no');
    await g.run('a');
    expect(g.asked.length).toBe(0);
    expect(g.s.commands).toEqual(['a']);
  });

  it('点「总是允许这条」记下原文,同一条命令下次不再问', async () => {
    const file = join(scratchDir, 'allowlist.json');
    const g = gated('ask-each-command', 'always', 30, { allowFile: file });
    await g.run('git status');
    expect(g.s.commands).toEqual(['git status']); // 同意了就跑,这一次不因为写名单而漏掉
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['git status']);
    await g.run('git status');
    expect(g.asked.length).toBe(1); // 第二次没有再弹
    expect(g.s.commands).toEqual(['git status', 'git status']);
  });

  it('名单只认整条命令的原文,换个写法照样要问', async () => {
    const file = join(scratchDir, 'allowlist.json');
    writeFileSync(file, JSON.stringify(['git status']), 'utf8');
    const g = gated('ask-each-command', 'no', 30, { allowFile: file });
    expect((await g.run('  git status \r\n')).failed).toBeUndefined(); // 首尾空白与换行风格不算差异
    expect(g.asked.length).toBe(0);
    await g.run('git status -s');
    expect(g.asked.length).toBe(1); // 多个参数就是另一条命令
    expect(g.s.commands).toEqual(['  git status \r\n']); // 免询问命中后跑的是原文
  });

  it('名单文件坏了当作没有,该问还是问', async () => {
    const file = join(scratchDir, 'allowlist.json');
    writeFileSync(file, '{ not json', 'utf8');
    const g = gated('ask-each-command', 'yes', 30, { allowFile: file });
    await g.run('a');
    expect(g.asked.length).toBe(1);
    expect(g.s.commands).toEqual(['a']);
  });

  it('环境提示词说清免询问名单只按原文比对,不是给 bot 的口子', () => {
    const text = gated('ask-each-turn', 'yes', 30, { allowFile: join(scratchDir, 'allowlist.json') })
      .world.envPromptVars()['shell.ask'];
    expect(text).toContain('免询问名单');
    expect(text).toContain('别开口要求');
    expect(gated('ask-each-turn', 'yes').world.envPromptVars()['shell.ask']).not.toContain('免询问名单');
  });

  it('环境提示词按档位说明会怎么问', () => {
    expect(gated('ask-each-turn', 'yes').world.envPromptVars()['shell.ask']).toContain('每一轮');
    expect(gated('never-ask', 'yes').world.envPromptVars()['shell.ask']).toContain('不事先问');
  });
});
