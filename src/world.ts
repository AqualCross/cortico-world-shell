/**
 * Shell World: `shell_run` runs one command in a fresh Niubash (bash) process and returns its
 * output and exit status. No state survives between calls — `cd`, exported variables and shell
 * state die with the process — so a step that needs several statements puts them into one command.
 * A timeout or an interrupted call terminates that call's process tree; stopping the World aborts a
 * call still in flight. The World itself keeps no process between calls.
 *
 * `worlds.shell.ask` decides whether the person is asked in a native message box first; the
 * default asks once per turn. The box shows the command's head and tail, the working directory and
 * the shell, and No is its default button. The receipt reports the children the command left
 * running: a one-shot shell orphans them the moment it exits, so the receipt is the one place that
 * can still say so.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { MAX_COMMAND_CHARS, SHELL_CONFIG_GROUP, SHELL_DEFAULTS, type AskLevel, type ShellConfigSection } from './config.ts';
import { askDesktop, ASK_TIMEOUT_MS, type Answer } from './ask.ts';
import { matchAllow, readAllow } from './allow.ts';
import { probeShellProgram, runCommand, shellKind, type LiveProcess, type RunResult, type RunShell, type RunSpec, type ShellKind } from './runner.ts';
import { detectRtk, type RtkInfo } from './rtk.ts';

const BASH_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const PWSH_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.pwsh.md', import.meta.url));

/** How many still-running children a receipt names before it switches to a count. */
const RECEIPT_PROCS = 6;

/** How much of a long command the approval box shows at each end. */
const ASK_EDGE_CHARS = 800;

/** The command as the person sees it: whole when short, head and tail with the omitted count when not. */
export function approvalPreview(command: string): string {
  if (command.length <= ASK_EDGE_CHARS * 2) return command;
  const omitted = command.length - ASK_EDGE_CHARS * 2;
  return `${command.slice(0, ASK_EDGE_CHARS)}\n…(中间省略 ${omitted} 字,共 ${command.length} 字)…\n${command.slice(-ASK_EDGE_CHARS)}`;
}

/** The tool schema is the same for both dialects; only the model-facing description changes. */
const SHELL_RUN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', maxLength: MAX_COMMAND_CHARS, description: '要执行的命令(可多行)。' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: '本条命令的超时上限,缺省用配置值。' },
  },
  required: ['command'],
};

/** The default tool schema; the definition's self-description and a PowerShell instance share it. */
export const SHELL_RUN_SPEC: ToolSpec = {
  name: 'shell_run',
  tags: ['act'],
  description:
    '在一条全新的 PowerShell 进程里运行一条命令,返回它的 stdout/stderr 和退出码。' +
    '命令之间没有状态延续:Set-Location、$env: 和变量都不保留,一条命令要用到的步骤写进同一次调用(分号、换行、管道都行)。' +
    '用 PowerShell 语法,不是 bash。' +
    '回执另带 [cwd](这条命令跑完时的目录,起点是配置的工作目录)和 [bg](跑完后仍存活的直接子进程;PowerShell 退出后它们就成了孤儿,要停就用回执里的 pid)。' +
    '按 worlds.shell.ask 的设置,命令之前可能在桌面上弹一个「是/否」确认框;被拒就没执行,换个写法重试也还是同一条命令。框里会显示工作目录和程序,命令超过 1600 字只显示头尾,关键动作别藏在中间。' +
    '命令超时或调用被中断会终止这条命令的进程树。回执的 ok/fail 跟最后一条语句的 $?;失败时 exit 取 $LASTEXITCODE(命令里最后一次原生命令,没有就是 1)。要省 token 可把可压缩命令加 rtk 前缀(见环境提示)。',
  parameters: SHELL_RUN_PARAMETERS,
};

/** The Niubash/bash variant, used when worlds.shell.shell points at niu. */
export const SHELL_RUN_SPEC_BASH: ToolSpec = {
  name: 'shell_run',
  tags: ['act'],
  description:
    '在一条全新的 Niubash(bash)进程里运行一条命令,返回它的 stdout/stderr 和退出码。' +
    '命令之间没有状态延续:cd 过的目录、export 的变量都不保留,一条命令要用到的步骤写进同一次调用(分号、换行、管道都行)。' +
    '用 bash 语法,不是 PowerShell。' +
    '回执另带 [cwd](这条命令跑完时的目录,起点是配置的工作目录)和 [bg](跑完后仍存活的直接子进程;shell 退出后它们就成了孤儿,要停就用回执里的 pid)。' +
    '按 worlds.shell.ask 的设置,命令之前可能在桌面上弹一个「是/否」确认框;被拒就没执行,换个写法重试也还是同一条命令。框里会显示工作目录和程序,命令超过 1600 字只显示头尾,关键动作别藏在中间。' +
    '命令超时或调用被中断会终止这条命令的进程树。要省 token 可把可压缩命令加 rtk 前缀(见环境提示)。',
  parameters: SHELL_RUN_PARAMETERS,
};

export function shellRunSpec(kind: ShellKind): ToolSpec {
  return kind === 'pwsh' ? SHELL_RUN_SPEC : SHELL_RUN_SPEC_BASH;
}

/** `node(18244), python(9911)` — what the command left running. */
export function liveNames(procs: LiveProcess[], cap = RECEIPT_PROCS): string {
  const named = procs.slice(0, cap).map((p) => `${p.name.replace(/\.exe$/i, '')}(${p.pid})`);
  if (procs.length > cap) named.push(`…共 ${procs.length} 个`);
  return named.join(', ');
}

/** Render a result into the model-facing receipt. */
export function formatResult(r: RunResult): ToolOutcome {
  const head = r.timedOut
    ? '[timeout] 命令超时,它的进程树已被终止;下面是截至此刻的输出。'
    : r.aborted
      ? '[interrupted] 命令被中断,它的进程树已被终止;下面是截至此刻的输出。'
      : r.incomplete
        ? `[incomplete] 命令没跑到收尾(exit=${r.exitCode === '' ? '?' : r.exitCode}):它提前退出了或脚本没解析完,拿不到 [cwd]/[bg]。`
        : `[${r.ok ? 'ok' : 'fail'}] exit=${r.exitCode === '' ? '?' : r.exitCode}`;
  // cwd and the leftover children come before stdout so they survive the WebUI's receipt preview.
  const parts: string[] = [head];
  if (r.cwd) parts.push(`[cwd] ${r.cwd}`);
  if (r.procs.length) parts.push(`[bg] ${liveNames(r.procs)}`);
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
  if (r.truncated) parts.push('[output truncated]');
  return { text: parts.join('\n'), failed: !r.ok && !r.timedOut && !r.aborted ? true : undefined };
}

export interface ShellWorldOptions {
  /** `worlds.shell` live reference. */
  cfg: ShellConfigSection;
  /** Working directory for every command when `cfg.cwd` is empty. */
  defaultCwd: string;
  /** The免询问 list: commands this person pre-approved by hand and need not be asked about again. */
  allowFile?: string;
  /** Name the approval dialog is signed with. */
  botName?: string;
  /** Test seam; defaults to the native desktop yes/no box. */
  ask?: (question: string, signal?: AbortSignal) => Promise<Answer>;
  /** Test seam; defaults to a real `runCommand`. */
  run?: RunShell;
}

/** Refused or unanswered: the command never reached a shell. */
class NotPermitted extends Error {}

export class ShellWorld implements World {
  readonly id = 'shell';
  private host: WorldHost | null = null;
  private rtk: RtkInfo = { available: false };
  private rtkChecked = false;
  private version = '';
  /** A yes for the current turn only; `ask-each-turn` reuses it, and a refusal stands until the turn ends. */
  private turnGranted = false;
  /** In-flight question, so parallel calls in one round raise one box. */
  private pendingAsk: Promise<Answer> | null = null;
  /** Until when an `ask-once` yes holds. */
  private grantedUntil = 0;
  /** The免询问 list as loaded at mount; edits on disk apply at the next mount, not mid-turn. */
  private allowEntries: string[] | null = null;
  /** Running calls, so `stop()` can terminate their shells instead of leaving them behind. */
  private readonly active = new Set<AbortController>();

  constructor(private readonly opts: ShellWorldOptions) {}

  onTurnEnded(): void {
    this.turnGranted = false;
    this.pendingAsk = null;
  }

  /** A handoff replaces the model's context; a per-turn yes does not cross that boundary. */
  onHandoffEnded(): void {
    this.turnGranted = false;
    this.pendingAsk = null;
  }

  private allowList(): string[] {
    return (this.allowEntries ??= this.opts.allowFile ? readAllow(this.opts.allowFile) : []);
  }

  /** The configured executable picks the dialect; the live config can switch it. */
  private kind(): ShellKind {
    return shellKind(this.opts.cfg.shell || SHELL_DEFAULTS.shell);
  }

  private askLevel(): AskLevel {
    return this.opts.cfg.ask || SHELL_DEFAULTS.ask;
  }

  /** Gate one command according to `worlds.shell.ask` and the免询问 list; throws when the person says no. */
  private async permit(command: string, signal?: AbortSignal): Promise<void> {
    const level = this.askLevel();
    if (level === 'never-ask') return;
    if (level === 'ask-each-turn' && this.turnGranted) return;
    if (level === 'ask-once' && Date.now() < this.grantedUntil) return;
    const entries = this.allowList();
    if (entries.length && matchAllow(entries, command)) {
      // Logged, because "it ran without asking" has to be visible in the run record.
      this.host?.log?.info('命令命中免询问名单,没有询问', { command: command.slice(0, 500) });
      return;
    }
    const who = this.opts.botName || 'bot';
    const cwd = this.opts.cfg.cwd || this.opts.defaultCwd;
    const shell = this.opts.cfg.shell || SHELL_DEFAULTS.shell;
    const program = this.version ? `${shell} (${this.version})` : shell;
    const question = `${who} 想运行这条命令:\n\n工作目录: ${cwd}\n程序: ${program}\n\n${approvalPreview(command)}\n\n可以吗?(${ASK_TIMEOUT_MS / 1000} 秒不答按拒绝)`;
    const ask = this.opts.ask ?? ((q, s) => askDesktop(q, {
      signal: s,
      onAnomaly: (detail) => this.host?.log?.warn('确认框没有给出答案,按拒绝处理', detail),
    }));
    // 「每条命令」 always re-asks. The other levels share one in-flight box, and a no is kept for the
    // rest of the turn: the second call fails at once instead of nagging the person again.
    const answer = level === 'ask-each-command'
      ? await ask(question, signal)
      : await (this.pendingAsk ??= ask(question, signal));
    if (answer !== 'yes') {
      this.host?.log?.warn('命令未获同意,没有执行', { answer, command: command.slice(0, 500) });
      throw new NotPermitted(answer === 'timeout'
        ? `弹窗问了,${ASK_TIMEOUT_MS / 1000} 秒没人理,命令没执行。`
        : '弹窗里点了「否」,命令没执行。');
    }
    this.pendingAsk = null;
    this.turnGranted = true;
    if (level === 'ask-once') this.grantedUntil = Date.now() + (this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes) * 60_000;
  }

  envPromptVars(): Record<string, string> {
    const shell = this.opts.cfg.shell || SHELL_DEFAULTS.shell;
    const cwd = this.opts.cfg.cwd || this.opts.defaultCwd;
    // Detection is a PATH lookup; it never executes rtk. It runs at mount when the hint is on,
    // and lazily if the hint is turned on later without a restart.
    if (this.opts.cfg.suggestRtk && !this.rtkChecked) {
      this.rtk = detectRtk();
      this.rtkChecked = true;
    }
    const rtk = this.opts.cfg.suggestRtk
      ? this.rtk.available
        ? `RTK 可用(${this.rtk.path}):把可压缩的命令改成 rtk 前缀能大幅减少读到的输出,例如 \`rtk git status\`、\`rtk cargo test\`。\`rtk\` 不在列表里的命令原样透传。`
        : 'RTK 未检测到:如需更省 token 可安装 rtk(CLI 输出压缩代理),装好后重启本 World 它会自动出现在这里。'
      : '未启用 rtk 提示。';
    return {
      'shell.program': this.version ? `${shell} (${this.version})` : shell,
      'shell.cwd': cwd,
      'shell.timeout': String(this.opts.cfg.timeoutMs || SHELL_DEFAULTS.timeoutMs),
      'shell.ask': {
        'ask-each-command': '每条命令之前都会在桌面上弹一个确认框问使用者(系统原生的「是/否」窗,默认按钮是「否」,回车和 Esc 都按拒绝算)。认真写命令,把要跑的东西说清楚,别连着弹一堆框。命令超过 1600 字时框里只显示头尾,关键动作别藏在中间。',
        'ask-each-turn': '每一轮第一条命令之前会在使用者桌面弹确认框(系统原生的「是/否」窗,默认按钮是「否」);这一轮同意过就不再问,拒了这轮后面的命令直接不执行。别换个写法绕。',
        'ask-once': `第一次要跑命令时弹确认框问使用者,同意后 ${this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes} 分钟内不再问。`,
        'never-ask': '命令不事先问使用者就跑,所以每一步都会留在日志里 —— 做了就做得到,别假装没做。',
      }[this.askLevel()] + (this.opts.allowFile
        ? ' 使用者可以自己编辑免询问名单(shell/allowlist.json,整条命令原文的 JSON 数组):名单在 World 启动时读取,改完要重启本 World 生效;名单里的命令不再弹框、直接执行(命中会在日志里留一行)。名单只按整条命令原文比对,换个写法就要重新问;这是替他省点击,不是给你的口子 —— 别开口要求把你常用的命令加进去。'
        : ''),
      'shell.rtk': rtk,
    };
  }

  tools(): ToolDef[] {
    return [this.runTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language === 'en';
    const kind = this.kind();
    const cwd = this.opts.cfg.cwd || this.opts.defaultCwd;
    return {
      label: 'Shell',
      lamps: [{
        label: kind === 'pwsh' ? 'PowerShell' : 'Niubash',
        state: this.version ? 'online' : 'offline',
        hint: this.version
          ? (en ? `${this.version} is available` : `${this.version} 可用`)
          : (en ? `${kind === 'pwsh' ? 'PowerShell' : 'Niubash'} not detected` : `未检测到 ${kind === 'pwsh' ? 'PowerShell' : 'Niubash'}`),
      }, {
        label: en ? 'Waiting for you' : '在等你点头',
        state: this.pendingAsk ? 'online' : 'offline',
        hint: this.pendingAsk
          ? (en ? 'a question is open on the desktop' : '桌面上有个确认框在等你')
          : (en ? 'no question open' : '没有在问的问题'),
      }],
      badges: [
        { label: 'Shell', value: this.version || '—', tone: this.version ? 'on' : 'plain' },
        { label: 'RTK', value: this.rtk.available ? (en ? 'found' : '已检测') : en ? 'absent' : '未找到', tone: this.rtk.available ? 'on' : 'off' },
        { label: en ? 'Working directory' : '工作目录', value: cwd, tone: 'plain' },
        {
          label: en ? 'Ask first' : '先问你',
          value: { 'ask-each-command': en ? 'every command' : '每条命令', 'ask-each-turn': en ? 'each turn' : '每轮', 'ask-once': en ? `once / ${this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes}min` : `${this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes} 分钟一次`, 'never-ask': en ? 'never' : '不问' }[this.askLevel()],
          tone: this.askLevel() === 'never-ask' ? 'off' : 'on',
        },
        {
          label: en ? 'Never asks' : '免询问',
          value: this.opts.allowFile ? String(this.allowList().length) : '—',
          tone: this.opts.allowFile ? 'plain' : 'off',
        },
      ],
      config: [SHELL_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.shell.envPrompt',
        title: en ? 'Shell · Environment prompt' : 'Shell · 环境提示词',
        description: en ? 'Standing facts about running commands.' : 'Shell 执行进 system 前缀的那一段。',
        path: kind === 'pwsh' ? PWSH_PROMPT_FILE : BASH_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'shell.program', description: en ? 'Shell program and version.' : 'Shell 程序与版本。' },
          { name: 'shell.cwd', description: en ? 'Working directory of every command.' : '每条命令的工作目录。' },
          { name: 'shell.timeout', description: en ? 'Per-command timeout in ms.' : '单条命令超时(ms)。' },
          { name: 'shell.ask', description: en ? 'When the person is asked first.' : '什么时候先问使用者、怎么问。' },
          { name: 'shell.rtk', description: en ? 'RTK availability and usage hint.' : 'rtk 是否可用与用法提示。' },
        ],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.turnGranted = false;
    this.grantedUntil = 0;
    this.pendingAsk = null;
    this.allowEntries = this.opts.allowFile ? readAllow(this.opts.allowFile) : [];
    const probe = probeShellProgram(this.opts.cfg.shell || SHELL_DEFAULTS.shell);
    this.version = probe.ok ? probe.version : '';
    this.rtk = { available: false };
    this.rtkChecked = false;
    if (this.opts.cfg.suggestRtk) {
      this.rtk = detectRtk();
      this.rtkChecked = true;
    }
  }

  async stop(): Promise<void> {
    // Disabling the World must stop the current call too; the signal makes the runner kill its tree.
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.host = null;
    this.pendingAsk = null;
    this.turnGranted = false;
    this.grantedUntil = 0;
    this.allowEntries = null;
    this.rtkChecked = false;
  }

  /** Everything one run needs, read from the live config so `shell`/`cwd` changes apply at once. */
  private spec(command: string, timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal): RunSpec {
    const cwd = this.opts.cfg.cwd || this.opts.defaultCwd;
    // The configured directory may not exist yet; spawning into a missing cwd fails obscurely.
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (e) {
      this.host?.log?.warn('工作目录建不出来,命令可能起不来', { cwd, reason: String(e) });
    }
    return {
      shell: this.opts.cfg.shell || SHELL_DEFAULTS.shell,
      cwd,
      command,
      timeoutMs,
      maxOutputBytes,
      signal,
      log: this.host?.log,
    };
  }

  private runTool(): ToolDef {
    return {
      ...shellRunSpec(this.kind()),
      interruptible: true,
      handler: async (args, ctx: ToolCallContext): Promise<ToolOutcome> => {
        const command = typeof args.command === 'string' ? args.command : '';
        if (!command.trim()) return { text: '[shell_run] command 不能为空', failed: true };
        if (command.length > MAX_COMMAND_CHARS) {
          return { text: `[shell_run] command 超过 ${MAX_COMMAND_CHARS} 字,拆成几条跑。`, failed: true };
        }
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : this.opts.cfg.timeoutMs || SHELL_DEFAULTS.timeoutMs;
        const maxOutputBytes = this.opts.cfg.maxOutputBytes || SHELL_DEFAULTS.maxOutputBytes;
        const controller = new AbortController();
        this.active.add(controller);
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
        try {
          try {
            await this.permit(command, signal);
          } catch (e) {
            if (signal.aborted) {
              return { text: '[未执行] 调用被中断,命令没有进任何进程。', failed: true };
            }
            return {
              text: `[未执行] ${e instanceof Error ? e.message : String(e)}命令没有进任何进程,所以什么都没发生。不要换个写法重试,等使用者开口。`,
              failed: true,
            };
          }
          try {
            const res = await (this.opts.run ?? runCommand)(this.spec(command, timeoutMs, maxOutputBytes, signal));
            return formatResult(res);
          } catch (e) {
            return { text: `[shell_run 失败] ${e instanceof Error ? e.message : String(e)}`, failed: true };
          }
        } finally {
          this.active.delete(controller);
        }
      },
    };
  }
}
