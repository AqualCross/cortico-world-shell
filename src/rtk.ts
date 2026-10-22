/** Locate the `rtk` proxy binary once, for the environment-prompt hint. Locating never runs it. */
import { spawnSync } from 'node:child_process';

export interface RtkInfo {
  available: boolean;
  path?: string;
}

export function detectRtk(): RtkInfo {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, ['rtk'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.error || r.status !== 0) return { available: false };
  const path = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!path) return { available: false };
  return { available: true, path };
}
