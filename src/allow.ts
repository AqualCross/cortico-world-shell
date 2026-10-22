/**
 * The免询问 list: commands the person does not want to be asked about again.
 *
 * It is a plain JSON array of command texts in the World's data directory, edited by hand (the
 * approval box is a native Yes/No and has no "always allow this one" button, by design). Matching
 * is the whole command text after whitespace normalisation — no prefixes, no globs, no "same
 * program": `git status` on the list says nothing about `git push`, and a reworded command is
 * asked again.
 *
 * What this list is *not*: a security boundary. The bot has a shell, so it could in principle write
 * this file itself. The World reads the list once at mount and keeps it in memory, so a write does
 * not change the running session; the list only removes repeat questions from the person's day.
 * The gate itself — a click outside the model — is what the design rests on, and every hit is
 * logged so the run record shows which commands ran without asking.
 */
import { readFileSync } from 'node:fs';

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
