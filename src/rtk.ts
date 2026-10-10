/** Locate the `rtk` proxy binary once, for the environment-prompt hint. Detection is non-fatal. */
import { spawnSync } from 'node:child_process';

export interface RtkInfo {
  available: boolean;
  path?: string;
  version?: string;
}

export function detectRtk(): RtkInfo {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, ['rtk'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.error || r.status !== 0) return { available: false };
  const path = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!path) return { available: false };
  let version = '';
  const v = spawnSync(path, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (!v.error && v.status === 0) version = (v.stdout ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
  return { available: true, path, version };
}
