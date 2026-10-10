/**
 * Shell World: one persistent PowerShell 7 process, a `shell_run` tool that streams its output
 * back as the model's tool result, and an environment prompt that states where the session runs
 * and whether `rtk` is available. `worlds.shell.ask` decides whether the person is asked on the
 * desktop first; the default asks once per turn.
 *
 * Every receipt carries the session's directory and the child processes still alive under it, and
 * the same set is shown on the console and in the environment prompt: what the bot starts never
 * goes invisible.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { SHELL_CONFIG_GROUP, SHELL_DEFAULTS, type AskLevel, type ShellConfigSection } from './config.ts';
import { askDesktop, ASK_TIMEOUT_MS, type Answer } from './ask.ts';
import { addAllow, matchAllow, readAllow } from './allow.ts';
import { PwshSession, probeShellVersion, type LiveProcess, type RunResult, type ShellSession } from './session.ts';
import { detectRtk, type RtkInfo } from './rtk.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** How many still-running children a receipt names before it switches to a count. */
const RECEIPT_PROCS = 6;

/** `node(18244), python(9911)` — what the session left running. */
export function liveNames(procs: LiveProcess[], cap = RECEIPT_PROCS): string {
  const named = procs.slice(0, cap).map((p) => `${p.name.replace(/\.exe$/i, '')}(${p.pid})`);
  if (procs.length > cap) named.push(`…共 ${procs.length} 个`);
  return named.join(', ');
}

/** Render a result into the model-facing receipt. */
export function formatResult(r: RunResult): ToolOutcome {
  const head = r.timedOut
    ? '[timeout] 命令未在期限内结束,已丢弃并重启会话;下面是它截至此刻产出的部分。'
    : `[${r.ok ? 'ok' : 'fail'}] exit=${r.exitCode === '' ? '-' : r.exitCode} $?=${r.ok}`;
  // cwd and the leftover children come before stdout so they survive the console's receipt preview.
  const parts: string[] = [head];
  if (r.cwd) parts.push(`[cwd] ${r.cwd}`);
  if (r.procs.length) parts.push(`[bg] ${liveNames(r.procs)}`);
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
  if (r.truncated) parts.push('[output truncated]');
  return { text: parts.join('\n'), failed: !r.ok && !r.timedOut ? true : undefined };
}

export interface ShellWorldOptions {
  /** `worlds.shell` live reference. */
  cfg: ShellConfigSection;
  timezone: string;
  /** Directory a new session starts in when `cfg.cwd` is empty. */
  defaultCwd: string;
  /** Where the session records its own pid, so a crash's leftovers get claimed by the next start. */
  stateFile?: string;
  /** The免询问 list: commands this person approved once and need not be asked about again. */
  allowFile?: string;
  /** Name the approval dialog is signed with. */
  botName?: string;
  /** Test seam; defaults to the native desktop yes/no box. */
  ask?: (question: string, signal?: AbortSignal) => Promise<Answer>;
  /** Test seam; defaults to a real `PwshSession` built from the live config. */
  createSession?: (opts: {
    shell: string; cwd: string; log: WorldHost['log'] | undefined; stateFile: string | undefined;
  }) => ShellSession;
}

/** Refused or unanswered: the command never reached the session. */
class NotPermitted extends Error {}

export class ShellWorld implements World {
  readonly id = 'shell';
  private host: WorldHost | null = null;
  private session: ShellSession | null = null;
  private rtk: RtkInfo = { available: false };
  private version = '';
  /** A yes for the current turn only; `ask-each-turn` reuses it, and a refusal stands until the turn ends. */
  private turnGranted = false;
  /** In-flight question, so parallel calls in one round raise one box. */
  private pendingAsk: Promise<Answer> | null = null;
  /** Until when an `ask-once` yes holds. */
  private grantedUntil = 0;

  constructor(private readonly opts: ShellWorldOptions) {}

  onTurnEnded(): void {
    this.turnGranted = false;
    this.pendingAsk = null;
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
    const file = this.opts.allowFile;
    if (file && matchAllow(readAllow(file), command)) {
      // Logged, because "it ran without asking" has to be visible in the run record.
      this.host?.log?.info('命令命中免询问名单,没有询问', { command: command.slice(0, 500) });
      return;
    }
    const who = this.opts.botName || 'bot';
    const body = command.length > 500 ? `${command.slice(0, 500)}\n…(共 ${command.length} 字,日志里有全文)` : command;
    const question = `${who} 想运行这条 PowerShell 命令:\n\n${body}\n\n可以吗?`;
    const ask = this.opts.ask ?? ((q, s) => askDesktop(q, {
      shell: this.opts.cfg.shell || SHELL_DEFAULTS.shell,
      signal: s,
      onAnomaly: (detail) => this.host?.log?.warn('确认框没有给出答案,按拒绝处理', detail),
    }));
    // 「每条命令」 always re-asks. The other levels share one in-flight box, and a no is kept for the
    // rest of the turn: the second call fails at once instead of nagging the person again.
    const answer = level === 'ask-each-command'
      ? await ask(question, signal)
      : await (this.pendingAsk ??= ask(question, signal));
    if (answer !== 'yes' && answer !== 'always') {
      this.host?.log?.warn('命令未获同意,没有执行', { answer, command: command.slice(0, 500) });
      throw new NotPermitted(answer === 'timeout'
        ? `弹窗问了,${ASK_TIMEOUT_MS / 1000} 秒没人理,命令没执行。`
        : '弹窗里点了「拒绝」,命令没执行。');
    }
    if (answer === 'always' && file) {
      const r = addAllow(file, command);
      if (r.ok) this.host?.log?.warn('这条命令已记入免询问名单', { file, count: r.entries.length, reason: r.reason });
      else this.host?.log?.warn('免询问名单没写进去,下次还会问', { file, reason: r.reason });
    }
    this.pendingAsk = null;
    this.turnGranted = true;
    if (level === 'ask-once') this.grantedUntil = Date.now() + (this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes) * 60_000;
  }

  /** Built lazily so `create()` and a disabled mount never touch PowerShell. */
  private ensureSession(): ShellSession {
    if (this.session) return this.session;
    const shell = this.opts.cfg.shell || SHELL_DEFAULTS.shell;
    const cwd = this.opts.cfg.cwd || this.opts.defaultCwd;
    // The configured directory may not exist yet; spawning into a missing cwd fails obscurely.
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (e) {
      this.host?.log?.warn('起始目录建不出来,会话可能起不来', { cwd, reason: String(e) });
    }
    this.session = this.opts.createSession
      ? this.opts.createSession({ shell, cwd, log: this.host?.log, stateFile: this.opts.stateFile })
      : new PwshSession({ shell, cwd, log: this.host?.log, stateFile: this.opts.stateFile });
    return this.session;
  }

  envPromptVars(): Record<string, string> {
    const shell = this.opts.cfg.shell || SHELL_DEFAULTS.shell;
    const cwd = this.opts.cfg.cwd || this.opts.defaultCwd;
    const rtk = this.opts.cfg.suggestRtk
      ? this.rtk.available
        ? `RTK 可用(${this.rtk.version || this.rtk.path}):把可压缩的命令改成 rtk 前缀能大幅减少读到的输出,例如 \`rtk git status\`、\`rtk cargo test\`。\`rtk\` 不在列表里的命令原样透传。`
        : 'RTK 未检测到:如需更省 token 可安装 rtk(CLI 输出压缩代理),装好后它会自动出现在这里。'
      : '未启用 rtk 提示。';
    const st = this.session?.status();
    const procs = !st
      ? '会话尚未开启,没有你起的进程在跑。'
      : st.procs.length
      ? `截至上一条完成的命令,你起的这些进程还在跑:\n${st.procs.map((p) => `- ${p.name.replace(/\.exe$/i, '')}(${p.pid}) ${(p.cmd || '').replace(/\s+/g, ' ').trim().slice(0, 90)}`).join('\n')}\n它们不随会话重启消失;要停就自己 \`Stop-Process -Id\`,不确定就 \`Get-Process\` 再看一眼。`
      : '目前没有你起的进程还在跑(只统计 pwsh 会话的直接子进程;脱离这条链的服务和已换父的进程不在此列)。';
    return {
      'shell.program': this.version ? `${shell} (${this.version})` : shell,
      'shell.cwd': cwd,
      'shell.timeout': String(this.opts.cfg.timeoutMs || SHELL_DEFAULTS.timeoutMs),
      'shell.ask': {
        'ask-each-command': '每条命令之前都会在桌面上弹一个确认框问使用者(三个按钮:只这次允许 / 总是允许这条 / 拒绝,回车和 Esc 都是拒绝)。认真写命令,把要跑的东西说清楚,别连着弹一堆框。',
        'ask-each-turn': '每一轮第一条命令之前会在使用者桌面弹确认框;这一轮同意过就不再问,拒了这轮后面的命令直接不执行。别换个写法绕。',
        'ask-once': `第一次要跑命令时弹确认框问使用者,同意后 ${this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes} 分钟内不再问。`,
        'never-ask': '命令不事先问使用者就跑,所以每一步都会留在日志里 —— 做了就做得到,别假装没做。',
      }[this.askLevel()] + (this.opts.allowFile
        ? ' 使用者点「总是允许这条」会把那条命令的原文记进免询问名单,此后它不再弹框、直接执行(命中会在日志里留一行)。名单只按整条命令原文比对,换个写法就要重新问;这是替他省点击,不是给你的口子 —— 别开口要求把你常用的命令加进去。'
        : ''),
      'shell.rtk': rtk,
      'shell.processes': procs,
    };
  }

  tools(): ToolDef[] {
    return [this.runTool(), this.restartTool()];
  }

  console(language: Language = 'zh'): WorldConsoleDecl {
    const en = language === 'en';
    const st = this.session?.status() ?? { running: false, pid: null, cwd: null, procs: [] };
    return {
      label: en ? 'Shell' : 'Shell 会话',
      lamps: [{
        label: en ? 'PowerShell session' : 'PowerShell 会话',
        state: st.running ? 'online' : 'offline',
        hint: st.running ? (en ? 'a session is alive' : '会话存活中') : (en ? 'no session yet' : '尚未开会话'),
      }, {
        label: en ? 'Waiting for you' : '在等你点头',
        state: this.pendingAsk ? 'online' : 'offline',
        hint: this.pendingAsk
          ? (en ? 'a question is open on the desktop' : '桌面上有个确认框在等你')
          : (en ? 'no question open' : '没有在问的问题'),
      }],
      badges: [
        { label: en ? 'Shell' : 'Shell', value: this.version || '—', tone: this.version ? 'on' : 'plain' },
        { label: 'RTK', value: this.rtk.available ? (en ? 'found' : '已检测') : en ? 'absent' : '未找到', tone: this.rtk.available ? 'on' : 'off' },
        {
          label: en ? 'Left running' : '它起的进程',
          value: st.procs.length ? `${st.procs.length} · ${liveNames(st.procs, 2)}` : (en ? 'none' : '无'),
          tone: st.procs.length ? 'on' : 'plain',
        },
        { label: en ? 'Directory' : '当前目录', value: st.cwd ?? '—', tone: st.cwd ? 'plain' : 'off' },
        {
          label: en ? 'Ask first' : '先问你',
          value: { 'ask-each-command': en ? 'every command' : '每条命令', 'ask-each-turn': en ? 'each turn' : '每轮', 'ask-once': en ? `once / ${this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes}min` : `${this.opts.cfg.grantMinutes || SHELL_DEFAULTS.grantMinutes} 分钟一次`, 'never-ask': en ? 'never' : '不问' }[this.askLevel()],
          tone: this.askLevel() === 'never-ask' ? 'off' : 'on',
        },
        {
          label: en ? 'Never asks' : '免询问',
          value: this.opts.allowFile ? String(readAllow(this.opts.allowFile).length) : '—',
          tone: this.opts.allowFile ? 'plain' : 'off',
        },
      ],
      config: [SHELL_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.shell.envPrompt',
        title: en ? 'Shell · Environment prompt' : 'Shell · 环境提示词',
        description: en ? 'Standing facts about the shell session.' : 'Shell 会话进 system 前缀的那一段。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'shell.program', description: en ? 'Shell program and version.' : 'PowerShell 程序与版本。' },
          { name: 'shell.cwd', description: en ? 'Session start directory.' : '会话起始目录。' },
          { name: 'shell.timeout', description: en ? 'Per-command timeout in ms.' : '单条命令超时(ms)。' },
          { name: 'shell.ask', description: en ? 'When the person is asked first.' : '什么时候先问使用者、怎么问。' },
          { name: 'shell.rtk', description: en ? 'RTK availability and usage hint.' : 'rtk 是否可用与用法提示。' },
          { name: 'shell.processes', description: en ? 'Children of the session still running.' : '会话里还活着的子进程清单。' },
        ],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const probe = probeShellVersion(this.opts.cfg.shell || SHELL_DEFAULTS.shell);
    this.version = probe.ok ? probe.version : '';
    this.rtk = detectRtk();
  }

  async stop(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.host = null;
    if (s) await s.dispose();
  }

  private runTool(): ToolDef {
    return {
      name: 'shell_run',
      tags: ['act'],
      interruptible: true,
      description:
        '在同一个持续存活的 PowerShell 7 会话里运行一条命令,返回它的 stdout/stderr 和成败。' +
        '回执另带 [cwd](命令跑完时的目录,不用自己问)和 [bg](跑完后仍存活的子进程)。' +
        '按 worlds.shell.ask 的设置,命令之前可能在桌面上弹一个确认框问使用者(「只这次允许 / 总是允许这条 / 拒绝」);被拒就没执行,换个写法重试也还是同一条命令。' +
        'cd、$env: 变量、会话里定义的变量在多次调用之间保留。命令超时会丢弃并重启会话(回到起始目录,但你起的进程不会因此停下)。' +
        '要省 token 可把可压缩命令加 rtk 前缀(见环境提示)。需要 shell:cmd 语法或管道时,直接写 PowerShell 语法。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', maxLength: 8000, description: '要执行的 PowerShell 语句(可多行)。' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: '本条命令的超时上限,缺省用配置值。' },
        },
        required: ['command'],
      },
      handler: async (args, ctx: ToolCallContext): Promise<ToolOutcome> => {
        const command = typeof args.command === 'string' ? args.command : '';
        if (!command.trim()) return { text: '[shell_run] command 不能为空', failed: true };
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : this.opts.cfg.timeoutMs || SHELL_DEFAULTS.timeoutMs;
        const maxOutputBytes = this.opts.cfg.maxOutputBytes || SHELL_DEFAULTS.maxOutputBytes;
        try {
          await this.permit(command, ctx.signal);
        } catch (e) {
          return {
            text: `[未执行] ${e instanceof Error ? e.message : String(e)}命令没有进会话,所以什么都没发生。不要换个写法重试,等使用者开口。`,
            failed: true,
          };
        }
        try {
          const res = await this.ensureSession().run(command, { timeoutMs, maxOutputBytes, signal: ctx.signal });
          return formatResult(res);
        } catch (e) {
          return { text: `[shell_run 失败] ${e instanceof Error ? e.message : String(e)}`, failed: true };
        }
      },
    };
  }

  private restartTool(): ToolDef {
    return {
      name: 'shell_restart',
      tags: ['flow'],
      description: '丢弃当前 PowerShell 会话并开一个全新的:回到起始目录、清空会话内的变量。用于换 shell 配置后生效,或会话状态脏了重来。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      handler: async (): Promise<ToolOutcome> => {
        const s = this.ensureSession();
        // Restarting the session does not stop what it started; say so before the model assumes it cleaned up.
        const left = s.status().procs;
        await s.restart();
        const st = s.status();
        const tail = left.length ? `;旧会话起的 ${left.length} 个进程还在跑:${liveNames(left)}` : '';
        return { text: `[shell_restart] 新会话已就绪。shell=${this.version || this.opts.cfg.shell || SHELL_DEFAULTS.shell},cwd=${st.cwd ?? '(未设)'}${tail}` };
      },
    };
  }
}
