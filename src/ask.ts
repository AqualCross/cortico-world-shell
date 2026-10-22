/**
 * The approval dialog: the native Windows message box, the same one the computer-control World
 * asks with (`user32!MessageBoxTimeoutW` through koffi) — Yes/No with the question icon, raised
 * and kept on top, closing itself after `timeoutMs`. No is the default button, so a stray Enter
 * refuses.
 *
 * Approvals must happen outside the model, otherwise it can forge a "the person agreed". This
 * extension layer cannot reach the app's own `askPermission` hook (that belongs to the computer
 * World), so the box is drawn here. It runs on a koffi worker thread, so the box does not block
 * the World while it waits.
 *
 * A message box has system button labels; there is no third button for "always allow this
 * command". The免询问 list stays a plain file the person edits by hand.
 */
import koffi from 'koffi';

export type Answer = 'yes' | 'no' | 'timeout';

/** How long the person gets to answer before the command is refused. */
export const ASK_TIMEOUT_MS = 60_000;

/** MessageBox return codes; `MB_TIMEDOUT` is what `MessageBoxTimeoutW` adds to the winuser.h set. */
export const MSGBOX = { yes: 6, no: 7, timeout: 32000 } as const;

/** Anything but an explicit Yes refuses: No, the timeout code, or a value we do not recognise. */
export function mapMessageBoxResult(r: number): Answer {
  if (r === MSGBOX.yes) return 'yes';
  if (r === MSGBOX.timeout) return 'timeout';
  return 'no';
}

const MB_YESNO = 0x4, MB_ICONQUESTION = 0x20, MB_DEFBUTTON2 = 0x100, MB_SETFOREGROUND = 0x10000, MB_TOPMOST = 0x40000;

/**
 * Text as the person should see it: line endings folded, tabs kept, every other control character
 * and Unicode direction/zero-width mark escaped. A raw U+202E can make an approval box read in an
 * order the command does not run in.
 */
const INVISIBLE = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function displayText(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\\u000D')
    .replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

// Loaded once at module scope so a broken user32/koffi turns into a refused question, not a failed
// mount: a `yes` can only come from a box that actually rendered.
const messageBoxTimeout = (() => {
  try {
    const user32 = koffi.load('user32.dll');
    return user32.func('int __stdcall MessageBoxTimeoutW(void *hwnd, str16 text, str16 caption, uint32_t type, uint16_t lang, uint32_t ms)');
  } catch {
    return null;
  }
})();

export interface AskOptions {
  caption?: string;
  timeoutMs?: number;
  /**
   * Stops the wait early (resolves `no`); the box itself cannot be closed and stays until its own
   * timeout. Nothing is approved by a box that was abandoned.
   */
  signal?: AbortSignal;
  /**
   * Called when the box could not be shown or failed outright, so a broken dialog and a person
   * pressing No are distinguishable in the run log (both resolve `no`).
   */
  onAnomaly?: (detail: Record<string, unknown>) => void;
}

/** Show the box and wait. Anything but an explicit yes is a refusal, including a failed spawn. */
export function askDesktop(question: string, opts: AskOptions = {}): Promise<Answer> {
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (a: Answer): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(a);
    };
    const onAbort = (): void => done('no');
    if (opts.signal?.aborted) {
      done('no');
      return;
    }
    opts.signal?.addEventListener('abort', onAbort);
    if (!messageBoxTimeout) {
      opts.onAnomaly?.({ error: 'user32.dll / MessageBoxTimeoutW 不可用' });
      done('no');
      return;
    }
    try {
      messageBoxTimeout.async(null, displayText(question), opts.caption ?? 'Shell 确认', MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST, 0, timeoutMs, (err: unknown, r: number) => {
        if (err) {
          opts.onAnomaly?.({ error: String(err) });
          done('no');
          return;
        }
        done(mapMessageBoxResult(r));
      });
    } catch (e) {
      opts.onAnomaly?.({ error: String(e) });
      done('no');
    }
  });
}
