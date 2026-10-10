/** The WorldDefinition: id, defaults, the pwsh7 preflight, and the instance factory. */
import { join } from 'node:path';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';
import { SHELL_DEFAULTS, SHELL_ID, type ShellConfigSection } from './config.ts';
import { ShellWorld } from './world.ts';
import { probeShellVersion } from './session.ts';

export const SHELL: WorldDefinition<ShellConfigSection> = {
  id: SHELL_ID,
  label: 'Shell 会话',
  defaults: () => ({ ...SHELL_DEFAULTS }),
  preflight: (ctx) => {
    const shell = ctx.cfg.shell || SHELL_DEFAULTS.shell;
    const probe = probeShellVersion(shell);
    if (!probe.ok) {
      throw new Error(`找不到 PowerShell 7:命令「${shell}」(${probe.reason})。安装 pwsh7,或在 worlds.shell.shell 填它的完整路径。`);
    }
    if (probe.major < 7) {
      throw new Error(`「${shell}」是 ${probe.version},本 World 需要 PowerShell 7 或更高(不是 Windows PowerShell 5.1)。把 worlds.shell.shell 指向 pwsh。`);
    }
  },
  create: (ctx) => new ShellWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botName: ctx.botName,
    // The deployment directory, not the code checkout: an installed app's repoRoot is its own
    // program folder, which the bot must not scribble in and which an app update replaces.
    defaultCwd: ctx.botDir || ctx.repoRoot,
    // Per-world data directory, same place the other Worlds keep their own state files.
    stateFile: dataFile(ctx, 'session.json'),
    // Same directory: the免询问 list belongs to this deployment, not to a second one on the machine.
    allowFile: dataFile(ctx, 'allowlist.json'),
  }),
};

/**
 * A file this World owns under its own data directory, so two deployments never claim each other's
 * processes or borrow each other's approvals.
 */
function dataFile(ctx: WorldContext<ShellConfigSection>, name: string): string {
  return join(ctx.dataDir || ctx.botDir || ctx.repoRoot, SHELL_ID, name);
}
