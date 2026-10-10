/** Config section `worlds.shell`: defaults and the console config group. */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export const SHELL_ID = 'shell';

/** When the person is asked before a command runs. Same ladder as the computer-control World. */
export const ASK_LEVELS = ['ask-each-command', 'ask-each-turn', 'ask-once', 'never-ask'] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

export interface ShellConfigSection extends WorldSection {
  /** PowerShell 7 executable: a bare command resolved from PATH, or an absolute path. */
  shell: string;
  /** Start directory for a new session; empty = this deployment's directory. `cd` inside the session overrides it thereafter. */
  cwd: string;
  /** Ask on the desktop before running: every command, once per turn, once per `grantMinutes`, or never. */
  ask: AskLevel;
  /** How long an 「ask-once」 yes holds. */
  grantMinutes: number;
  /** Per-command wall clock; on expiry the command is abandoned and the session restarts. */
  timeoutMs: number;
  /** Truncate each of stdout and stderr beyond this many bytes, keeping head and tail. */
  maxOutputBytes: number;
  /** Mention `rtk` in the environment prompt so the bot can prefix compressible commands. */
  suggestRtk: boolean;
}

export const SHELL_DEFAULTS: ShellConfigSection = {
  enabled: false,
  shell: 'pwsh',
  cwd: '',
  ask: 'ask-each-turn',
  grantMinutes: 30,
  timeoutMs: 60_000,
  maxOutputBytes: 24_000,
  suggestRtk: true,
};

const K = `worlds.${SHELL_ID}`;

export const SHELL_CONFIG_GROUP: ConfigGroup = {
  id: `world:${SHELL_ID}`,
  owner: `world:${SHELL_ID}`,
  schema: {
    type: 'object',
    title: 'Shell 会话',
    properties: {
      [`${K}.shell`]: {
        type: 'string', title: 'PowerShell 程序', 'x-hot': false,
        description: 'pwsh 可执行文件:PATH 里的命令名(默认 pwsh)或完整路径。改后要 shell_restart 生效。',
      },
      [`${K}.cwd`]: {
        type: 'string', title: '起始目录', 'x-hot': false,
        description: '新会话的工作目录;留空用本部署目录(配置、记忆、运行数据所在)。会话内 cd 之后以实际所在为准。改后要 shell_restart 生效。',
      },
      [`${K}.ask`]: {
        type: 'string', title: '什么时候先问你', enum: [...ASK_LEVELS], 'x-hot': true,
        description: 'ask-each-command:每条命令前都弹框问;ask-each-turn:每一轮第一条命令前问一次;ask-once:问一次,同意后「同意管多久」内不再问;never-ask:都不问。弹框是桌面上的确认窗(只这次允许 / 总是允许这条 / 拒绝,回车与 Esc 都是拒绝),60 秒没答按拒绝算。免询问名单在 data 目录的 shell/allowlist.json 里,按整条命令原文比对。',
      },
      [`${K}.grantMinutes`]: { type: 'integer', title: '同意管多久', minimum: 1, maximum: 1440, 'x-suffix': '分钟', description: '只对 ask-once 有效。', 'x-hot': true },
      [`${K}.timeoutMs`]: {
        type: 'integer', title: '单条命令超时', minimum: 1000, maximum: 600000, 'x-suffix': 'ms', 'x-hot': true,
        description: '超过此时长命令被丢弃、会话重启,并回报已产出的部分。',
      },
      [`${K}.maxOutputBytes`]: {
        type: 'integer', title: '输出截断字节', minimum: 1000, maximum: 400000, 'x-suffix': 'B', 'x-hot': true,
        description: 'stdout 与 stderr 各自的字节上限,超出保头去尾。',
      },
      [`${K}.suggestRtk`]: {
        type: 'boolean', title: '提示使用 rtk', 'x-hot': true,
        description: '开启后在环境提示词里告知 rtk 是否可用,让 bot 自行用 rtk 前缀压缩命令输出。不自动改写命令。',
      },
    },
  },
};
