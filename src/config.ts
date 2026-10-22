/** Config section `worlds.shell`: defaults and the WebUI config group. */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export const SHELL_ID = 'shell';

/** The tool's command ceiling; the host does not enforce the JSON schema, the handler does. */
export const MAX_COMMAND_CHARS = 8000;

/** When the person is asked before a command runs. Same ladder as the computer-control World. */
export const ASK_LEVELS = ['ask-each-command', 'ask-each-turn', 'ask-once', 'never-ask'] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

export interface ShellConfigSection extends WorldSection {
  /** The shell executable: `pwsh` (PowerShell 7, the default) or Niubash's `niu`; each command starts a fresh process with it. */
  shell: string;
  /** Working directory of every command; empty = this deployment's directory. `cd` inside a command affects only that command. */
  cwd: string;
  /** Ask on the desktop before running: every command, once per turn, once per `grantMinutes`, or never. */
  ask: AskLevel;
  /** How long an 「ask-once」 yes holds. */
  grantMinutes: number;
  /** Per-command wall clock; on expiry that command's process is terminated. */
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
  ask: 'ask-once',
  grantMinutes: 30,
  timeoutMs: 60_000,
  maxOutputBytes: 24_000,
  suggestRtk: false,
};

const K = `worlds.${SHELL_ID}`;

export const SHELL_CONFIG_GROUP: ConfigGroup = {
  id: `world:${SHELL_ID}`,
  owner: `world:${SHELL_ID}`,
  schema: {
    type: 'object',
    title: 'Shell',
    properties: {
      [`${K}.shell`]: {
        type: 'string', title: 'Shell 程序', 'x-hot': true,
        description: '默认 pwsh(PowerShell 7);也可以填 niu(Niubash,bash)。按程序名选择方言:pwsh/powershell 用 PowerShell 语法,其他用 bash。每条命令都用它起一个新进程,改后立即生效。',
      },
      [`${K}.cwd`]: {
        type: 'string', title: '工作目录', 'x-hot': true,
        description: '每条命令的工作目录;留空用本部署目录(配置、记忆、运行数据所在)。命令里 cd 只影响那一条命令;目录不存在会在跑命令前建出来。',
      },
      [`${K}.ask`]: {
        type: 'string', title: '什么时候先问你', enum: [...ASK_LEVELS], 'x-hot': true,
        description: 'ask-each-command:每条命令前都弹框问;ask-each-turn:每一轮第一条命令前问一次;ask-once:问一次,同意后「同意管多久」内不再问;never-ask:都不问。弹框是桌面上系统原生的「是/否」确认窗(默认按钮是「否」,回车、Esc、60 秒不答都按拒绝算)。免询问名单在 data 目录的 shell/allowlist.json 里,按整条命令原文比对,自己编辑;World 启动时读取,改完要重启本 World 生效。',
      },
      [`${K}.grantMinutes`]: { type: 'integer', title: '同意管多久', minimum: 1, maximum: 1440, 'x-suffix': '分钟', description: '只对 ask-once 有效。', 'x-hot': true },
      [`${K}.timeoutMs`]: {
        type: 'integer', title: '单条命令超时', minimum: 1000, maximum: 600000, 'x-suffix': 'ms', 'x-hot': true,
        description: '超过此时长就终止这条命令的进程,并回报已产出的部分。',
      },
      [`${K}.maxOutputBytes`]: {
        type: 'integer', title: '输出截断字节', minimum: 1000, maximum: 400000, 'x-suffix': 'B', 'x-hot': true,
        description: 'stdout 与 stderr 各自的字节上限,超出保头去尾。进程运行期间内存里另有硬上限,不会因为命令狂刷输出把应用撑爆。',
      },
      [`${K}.suggestRtk`]: {
        type: 'boolean', title: '提示使用 rtk', 'x-hot': true,
        description: '默认关闭。开启后在环境提示词里告知 rtk 是否可用,让 bot 自行用 rtk 前缀压缩命令输出;不自动改写命令。',
      },
    },
  },
};
