import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { RunResult, RunSpec, RunShell } from '../src/runner.ts';
import type { Answer } from '../src/ask.ts';
import { ShellWorld, type ShellWorldOptions } from '../src/world.ts';
import { SHELL } from '../src/definition.ts';
import { MAX_COMMAND_CHARS, SHELL_DEFAULTS, type AskLevel } from '../src/config.ts';

/** Records runs and replays canned results; never spawns a shell. */
class FakeRunner {
  calls: RunSpec[] = [];
  result: RunResult = {
    stdout: 'ok-output', stderr: '', ok: true, exitCode: '0', cwd: '', procs: [],
    timedOut: false, aborted: false, incomplete: false, truncated: false,
  };
  run: RunShell = async (spec) => { this.calls.push(spec); return this.result; };
  get commands(): string[] { return this.calls.map((c) => c.command); }
}

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'shell-world-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

const call = {} as ToolCallContext;

function makeWorld(runner: FakeRunner, opts: Partial<ShellWorldOptions> = {}): { world: ShellWorld; tool: (name: string) => ToolDef } {
  const ctx = fakeWorldContext(SHELL, { scratchDir }) as { cfg: typeof SHELL_DEFAULTS };
  const world = new ShellWorld({
    cfg: { ...ctx.cfg }, defaultCwd: scratchDir,
    ask: async () => 'yes', run: runner.run, ...opts,
  });
  return { world, tool: (name) => world.tools().find((t) => t.name === name)! };
}

describe('Shell World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    expect((await dryMountWorld(SHELL, { scratchDir })).failures).toEqual([]);
  });

  it('只暴露 shell_run', () => {
    const { world } = makeWorld(new FakeRunner());
    expect(world.tools().map((t) => t.name)).toEqual(['shell_run']);
  });

  it('shell_run 透传命令、程序与工作目录,渲染 ok 回执', async () => {
    const s = new FakeRunner();
    const run = makeWorld(s).tool('shell_run');
    const res = (await run.handler({ command: 'echo hi' }, call)) as ToolOutcome;
    expect(s.commands).toEqual(['echo hi']);
    expect(s.calls[0].shell).toBe(SHELL_DEFAULTS.shell);
    expect(s.calls[0].cwd).toBe(scratchDir);
    expect(s.calls[0].timeoutMs).toBe(SHELL_DEFAULTS.timeoutMs);
    expect(s.calls[0].maxOutputBytes).toBe(SHELL_DEFAULTS.maxOutputBytes);
    expect(res.text).toContain('[ok] exit=0');
    expect(res.text).toContain('ok-output');
    expect(res.failed).toBeUndefined();
  });

  it('shell_run 空命令直接失败,不碰执行器', async () => {
    const s = new FakeRunner();
    const run = makeWorld(s).tool('shell_run');
    const res = (await run.handler({ command: '   ' }, call)) as ToolOutcome;
    expect(res.failed).toBe(true);
    expect(s.commands).toEqual([]);
  });

  it('超过命令上限直接失败,不碰执行器', async () => {
    const s = new FakeRunner();
    const res = (await makeWorld(s).tool('shell_run').handler({ command: 'a'.repeat(MAX_COMMAND_CHARS + 1) }, call)) as ToolOutcome;
    expect(res.failed).toBe(true);
    expect(res.text).toContain(String(MAX_COMMAND_CHARS));
    expect(s.commands).toEqual([]);
  });

  it('失败标 failed,超时与中断不标 failed', async () => {
    const s = new FakeRunner();
    const run = makeWorld(s).tool('shell_run');
    s.result = { ...s.result, stdout: '', ok: false, exitCode: '2' };
    expect(((await run.handler({ command: 'x' }, call)) as ToolOutcome).failed).toBe(true);
    s.result = { ...s.result, ok: false, exitCode: '', timedOut: true };
    expect(((await run.handler({ command: 'x' }, call)) as ToolOutcome).failed).toBeUndefined();
    s.result = { ...s.result, timedOut: false, aborted: true };
    expect(((await run.handler({ command: 'x' }, call)) as ToolOutcome).failed).toBeUndefined();
  });

  it('回执带 [cwd] 与 [bg],元信息排在输出前面', async () => {
    const s = new FakeRunner();
    s.result = {
      ...s.result, cwd: 'D:/project/ts',
      procs: [{ pid: 18244, name: 'node.exe', cmd: 'node server.js' }],
    };
    const res = (await makeWorld(s).tool('shell_run').handler({ command: 'x' }, call)) as ToolOutcome;
    expect(res.text).toContain('[cwd] D:/project/ts');
    expect(res.text).toContain('[bg] node(18244)');
    expect(res.text.indexOf('[bg]')).toBeLessThan(res.text.indexOf('ok-output'));
  });

  it('起始目录不存在时先建出来', async () => {
    const target = join(scratchDir, 'shell-work', 'deep');
    const ctx = fakeWorldContext(SHELL, { scratchDir }) as { cfg: typeof SHELL_DEFAULTS };
    const s = new FakeRunner();
    const world = new ShellWorld({
      cfg: { ...ctx.cfg, cwd: target }, defaultCwd: scratchDir,
      ask: async () => 'yes', run: s.run,
    });
    await world.tools()[0].handler!({ command: 'x' }, call);
    expect(existsSync(target)).toBe(true);
    expect(s.calls[0].cwd).toBe(target);
  });

  it('shell 与 cwd 改了立刻生效,不用重启什么', async () => {
    const ctx = fakeWorldContext(SHELL, { scratchDir }) as { cfg: typeof SHELL_DEFAULTS };
    const s = new FakeRunner();
    const cfg = { ...ctx.cfg };
    const world = new ShellWorld({ cfg, defaultCwd: scratchDir, ask: async () => 'yes', run: s.run });
    cfg.shell = 'C:/niubash/niu.exe';
    cfg.cwd = join(scratchDir, 'elsewhere');
    await world.tools()[0].handler!({ command: 'x' }, call);
    expect(s.calls[0].shell).toBe('C:/niubash/niu.exe');
    expect(s.calls[0].cwd).toBe(join(scratchDir, 'elsewhere'));
  });

  it('环境提示词不再报跨命令的进程清单', () => {
    const { world } = makeWorld(new FakeRunner());
    const vars = world.envPromptVars();
    expect(vars['shell.processes']).toBeUndefined();
    expect(vars['shell.cwd']).toBe(scratchDir);
  });

  it('WebUI 徽章报工作目录,没有进程徽章', () => {
    const { world } = makeWorld(new FakeRunner());
    const labels = (world.webUi('zh').badges ?? []).map((b) => b.label);
    expect(labels).toContain('工作目录');
    expect(labels).not.toContain('它起的进程');
  });

  it('describe 覆盖 tools() 的全部工具', () => {
    const { world } = makeWorld(new FakeRunner());
    const declared = new Set((SHELL.describe?.tools ?? []).map((t) => t.name));
    for (const tool of world.tools()) expect(declared.has(tool.name)).toBe(true);
  });

  it('webUi 声明指向存在的环境提示词模板', () => {
    const { world } = makeWorld(new FakeRunner());
    const doc = world.webUi('zh').promptDocs?.find((d) => d.role === 'envPrompt');
    expect(doc).toBeTruthy();
    expect(existsSync(doc!.path)).toBe(true);
  });

  it('默认 powershell:工具描述与提示词走 PowerShell 模板', () => {
    const { world } = makeWorld(new FakeRunner());
    expect(world.tools()[0].description).toContain('PowerShell');
    expect(world.webUi('zh').promptDocs?.[0].path.endsWith('ENV_PROMPT.pwsh.md')).toBe(true);
  });

  it('niu 配置继续用 bash 工具描述与提示词', () => {
    const ctx = fakeWorldContext(SHELL, { scratchDir }) as { cfg: typeof SHELL_DEFAULTS };
    const world = new ShellWorld({
      cfg: { ...ctx.cfg, shell: 'niu' },
      defaultCwd: scratchDir,
      ask: async () => 'yes',
      run: new FakeRunner().run,
    });
    expect(world.tools()[0].description).toContain('Niubash');
    expect(world.webUi('zh').promptDocs?.[0].path.endsWith('ENV_PROMPT.md')).toBe(true);
  });

  it('stop() 中止正在跑的命令', async () => {
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolveRun!: (r: RunResult) => void;
    const world = new ShellWorld({
      cfg: { ...SHELL_DEFAULTS, ask: 'never-ask' },
      defaultCwd: scratchDir,
      run: (spec) => {
        signal = spec.signal;
        markStarted();
        return new Promise<RunResult>((resolve) => { resolveRun = resolve; });
      },
    });
    const pending = world.tools()[0].handler!({ command: 'x' }, call) as Promise<ToolOutcome>;
    await started;
    await world.stop();
    expect(signal?.aborted).toBe(true);
    resolveRun({ stdout: '', stderr: '', ok: false, exitCode: '', cwd: '', procs: [], timedOut: false, aborted: true, incomplete: false, truncated: false });
    expect((await pending).text).toContain('[interrupted]');
  });
});

describe('先问再跑 worlds.shell.ask', () => {
  function gated(level: AskLevel, answer: Answer, grantMinutes = 30, extra: Partial<ShellWorldOptions> = {}) {
    const s = new FakeRunner();
    const asked: string[] = [];
    const world = new ShellWorld({
      cfg: { ...SHELL_DEFAULTS, ask: level, grantMinutes },
      defaultCwd: scratchDir,
      botName: 'Bot',
      ask: async (q) => { asked.push(q); return answer; },
      run: s.run,
      ...extra,
    });
    const run = (command: string) => world.tools().find((t) => t.name === 'shell_run')!.handler!({ command }, call) as Promise<ToolOutcome>;
    return { s, asked, world, run };
  }

  it('默认只问一次,不是不问', () => {
    expect(SHELL_DEFAULTS.ask).toBe('ask-once');
    expect(SHELL_DEFAULTS.suggestRtk).toBe(false);
    expect(SHELL_DEFAULTS.shell).toBe('powershell');
  });

  it('弹窗里写清是谁要跑什么', async () => {
    const g = gated('ask-each-turn', 'yes');
    await g.run('rm -rf x:/tmp');
    expect(g.asked[0]).toContain('Bot');
    expect(g.asked[0]).toContain('rm -rf x:/tmp');
    expect(g.s.commands).toEqual(['rm -rf x:/tmp']);
  });

  it('长命令显示头尾和省略字数,框里带工作目录与程序', async () => {
    const g = gated('ask-each-command', 'yes');
    const command = 'HEAD_' + 'a'.repeat(2000) + '_TAIL';
    await g.run(command);
    const q = g.asked[0];
    expect(q).toContain('HEAD_');
    expect(q).toContain('_TAIL');
    expect(q).toContain('中间省略');
    expect(q).not.toContain('a'.repeat(900));
    expect(q).toContain(`工作目录: ${scratchDir}`);
    expect(q).toContain(`程序: ${SHELL_DEFAULTS.shell}`);
    expect(g.s.commands).toEqual([command]);
  });

  it('每轮问一次:同意后这一轮不再问', async () => {
    const g = gated('ask-each-turn', 'yes');
    await g.run('a');
    await g.run('b');
    expect(g.asked.length).toBe(1);
    expect(g.s.commands).toEqual(['a', 'b']);
  });

  it('交接后同意不再跨上下文沿用', async () => {
    const g = gated('ask-each-turn', 'yes');
    await g.run('a');
    g.world.onHandoffEnded();
    await g.run('b');
    expect(g.asked.length).toBe(2);
  });

  it('每轮问一次:拒了就整轮不再问,也不执行', async () => {
    const g = gated('ask-each-turn', 'no');
    const first = await g.run('a');
    expect(first.failed).toBe(true);
    expect(first.text).toContain('[未执行]');
    expect(first.text).toContain('点了「否」');
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

  it('手写的免询问名单命中后不再弹框,照原文执行', async () => {
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

  it('名单在第一次使用时读入,运行中改文件不生效', async () => {
    const file = join(scratchDir, 'allowlist.json');
    writeFileSync(file, JSON.stringify(['a']), 'utf8');
    const g = gated('ask-each-command', 'yes', 30, { allowFile: file });
    await g.run('a');
    expect(g.asked.length).toBe(0);
    writeFileSync(file, JSON.stringify(['a', 'b']), 'utf8');
    await g.run('b');
    expect(g.asked.length).toBe(1);
    expect(g.s.commands).toEqual(['a', 'b']);
  });

  it('环境提示词说清免询问名单要自己编辑、不是给 bot 的口子', () => {
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
