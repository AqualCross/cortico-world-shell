/** Package entry: the default export is the `WorldDefinition`; the loader keys off `cortico.kind === 'world'`. */
import { SHELL } from './definition.ts';

export default SHELL;
export { SHELL };
export { SHELL_DEFAULTS, SHELL_CONFIG_GROUP, SHELL_ID, ASK_LEVELS } from './config.ts';
export type { ShellConfigSection, AskLevel } from './config.ts';
export { ShellWorld, formatResult, type ShellWorldOptions } from './world.ts';
export { askDesktop, encodeAskScript, ASK_TIMEOUT_MS, ASK_CODE, type Answer } from './ask.ts';
export { matchAllow, readAllow, addAllow, normalizeCommand, ALLOW_CAP } from './allow.ts';
export { claimCommand, parseClaim, readRecord, writeRecord, clearRecord, type SessionRecord, type ClaimResult } from './claim.ts';
export { PwshSession, probeShellVersion, splitSentinel, parseLive, truncateBytes, normalizeEol, type ShellSession, type RunResult, type LiveProcess, type SessionStatus } from './session.ts';
export { detectRtk, type RtkInfo } from './rtk.ts';
