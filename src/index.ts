/** Package entry: the default export is the `WorldDefinition`; the loader keys off `cortico.kind === 'world'`. */
import { SHELL } from './definition.ts';

export default SHELL;
export { SHELL };
export { SHELL_DEFAULTS, SHELL_CONFIG_GROUP, SHELL_ID, ASK_LEVELS, MAX_COMMAND_CHARS } from './config.ts';
export type { ShellConfigSection, AskLevel } from './config.ts';
export { ShellWorld, formatResult, liveNames, approvalPreview, SHELL_RUN_SPEC, type ShellWorldOptions } from './world.ts';
export { askDesktop, displayText, ASK_TIMEOUT_MS, MSGBOX, mapMessageBoxResult, type Answer, type AskOptions } from './ask.ts';
export { matchAllow, readAllow, normalizeCommand } from './allow.ts';
export {
  runCommand, probeShellVersion, buildScript, splitSentinel, parseProcLine, parseNiuVersion,
  truncateBytes, normalizeEol, stripAnsi, MAX_SCRIPT_CHARS,
  type RunSpec, type RunResult, type RunShell, type LiveProcess, type ShellProbe,
} from './runner.ts';
export { detectRtk, type RtkInfo } from './rtk.ts';
