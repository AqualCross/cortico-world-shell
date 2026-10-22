/** The WorldDefinition: id, defaults, the PowerShell/Niubash preflight, self-description, and the factory. */
import { join } from 'node:path';
import { describeTools, type WorldContext, type WorldDefinition } from 'cortico/world.ts';
import { SHELL_DEFAULTS, SHELL_ID, type ShellConfigSection } from './config.ts';
import { SHELL_RUN_SPEC, ShellWorld } from './world.ts';
import { probeShellProgram } from './runner.ts';

export const SHELL: WorldDefinition<ShellConfigSection> = {
  id: SHELL_ID,
  label: 'Shell',
  describe: {
    tools: describeTools([SHELL_RUN_SPEC], {
      shell_run: {
        zh: '在一次性 PowerShell 进程里运行一条命令',
        en: 'Run a command in a one-shot PowerShell process',
      },
    }),
    events: [],
  },
  defaults: () => ({ ...SHELL_DEFAULTS }),
  preflight: (ctx) => {
    const shell = ctx.cfg.shell || SHELL_DEFAULTS.shell;
    const probe = probeShellProgram(shell);
    if (!probe.ok) {
      throw new Error(probe.kind === 'pwsh'
        ? `找不到 PowerShell:命令「${shell}」(${probe.reason})。Windows 自带 powershell(5.1),或用 pwsh(PowerShell 7)并在 worlds.shell.shell 填完整路径。`
        : `找不到 Niubash:命令「${shell}」(${probe.reason})。安装 niubash(github.com/unixwin/niubash),或在 worlds.shell.shell 填 niu.exe 的完整路径。`);
    }
    if (probe.kind === 'pwsh' && probe.major < 5) {
      throw new Error(`「${shell}」是 ${probe.version},本 World 需要 PowerShell 5.1 或更高。把 worlds.shell.shell 指向 powershell 或 pwsh。`);
    }
    if (probe.kind === 'bash' && probe.major < 1) {
      throw new Error(`「${shell}」是 ${probe.version},本 World 需要 Niubash 1.x。把 worlds.shell.shell 指向 niu。`);
    }
  },
  create: (ctx) => new ShellWorld({
    cfg: ctx.cfg,
    botName: ctx.botName,
    // The deployment directory, not the code checkout: an installed app's repoRoot is its own
    // program folder, which the bot must not scribble in and which an app update replaces.
    defaultCwd: ctx.botDir || ctx.repoRoot,
    // Per-world data directory: the免询问 list belongs to this deployment, not to a second one on
    // the machine.
    allowFile: dataFile(ctx, 'allowlist.json'),
  }),
};

/** A file this World owns under its own data directory, so two deployments never borrow each other's approvals. */
function dataFile(ctx: WorldContext<ShellConfigSection>, name: string): string {
  return join(ctx.dataDir || ctx.botDir || ctx.repoRoot, SHELL_ID, name);
}
