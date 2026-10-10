/**
 * The免询问 list: commands the person approved once and does not want to be asked about again.
 *
 * It is a plain JSON array of command texts in the World's data directory, so it is readable and
 * editable by hand and diffable in a backup. Matching is the whole command text after whitespace
 * normalisation — no prefixes, no globs, no "same program": `git status` on the list says nothing
 * about `git push`, and a reworded command is asked again.
 *
 * What this list is *not*: a security boundary. The bot has a shell, so it could in principle write
 * this file itself. The list only removes repeat questions from the person's day; the gate itself —
 * a click outside the model — is what the design rests on, and every hit is logged so the run
 * record shows which commands ran without asking.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Entries one command may carry; a list this long is not a whitelist any more, it is a hole. */
export const ALLOW_CAP = 200;

/** The text two commands are compared by: line endings folded, outer whitespace gone. */
export function normalizeCommand(command: string): string {
  return command.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** A missing or damaged file just means nothing is pre-approved. */
export function readAllow(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && normalizeCommand(x) !== '');
  } catch {
    return [];
  }
}

export interface AllowMatch {
  /** The stored entry, which differs from the command in whitespace only. */
  entry: string;
}

/** Whom this command is already cleared by, if anyone. */
export function matchAllow(entries: string[], command: string): AllowMatch | null {
  const want = normalizeCommand(command);
  if (!want) return null;
  for (const entry of entries) {
    if (normalizeCommand(entry) === want) return { entry };
  }
  return null;
}

export interface AllowAddResult {
  ok: boolean;
  reason: string;
  entries: string[];
}

/** Remember one command. Already-listed and over-cap are reported, not silently dropped. */
export function addAllow(file: string, command: string): AllowAddResult {
  const want = normalizeCommand(command);
  const current = readAllow(file);
  if (!want) return { ok: false, reason: '命令是空的', entries: current };
  if (matchAllow(current, want)) return { ok: true, reason: 'already', entries: current };
  if (current.length >= ALLOW_CAP) return { ok: false, reason: `名单已满 ${ALLOW_CAP} 条`, entries: current };
  const entries = [...current, want];
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    return { ok: true, reason: 'added', entries };
  } catch (e) {
    return { ok: false, reason: String(e), entries: current };
  }
}
