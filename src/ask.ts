/**
 * The approval dialog: a small window on the person's desktop with three choices.
 *
 * It runs in its own short-lived PowerShell process, never in the working session — a refusal, an
 * ignored box or an abort must not cost the session its `cd` and variables, and the wait must not
 * count against the command timeout.
 *
 * A Win32 `MessageBox` cannot carry buttons we name, so this is a plain WinForms form: 「总是允许这条」
 * (which the World writes into the免询问 list), 「只这次允许」 and 「拒绝」. Enter and Esc both mean
 * 拒绝 — the safe default stays the safe default — and a form nobody touches closes itself at
 * `timeoutMs`, which counts as a refusal too. `pwsh` starts MTA, and WinForms needs a single-threaded
 * apartment, so the process is launched with `-STA`.
 */
import { spawn } from 'node:child_process';

export type Answer = 'yes' | 'always' | 'no' | 'timeout';

/** How long the person gets to answer before the command is refused. */
export const ASK_TIMEOUT_MS = 60_000;

/** The number the script prints for each outcome. */
export const ASK_CODE = { no: 0, yes: 1, always: 2, timeout: 3 } as const;

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * The dialog, in PowerShell.
 *
 * Not compiled C#: in pwsh 7 `Add-Type -TypeDefinition` cannot see `System.Windows.Forms` even after
 * the assembly is loaded (`error CS0234`), while the types themselves are usable directly once
 * `Add-Type -AssemblyName` has run. So the form is built here.
 */
function script(question: string, caption: string, timeoutMs: number): string {
  // Everything the model can shape (the command text inside the question) goes in as a quoted
  // literal — never a `@'…'@` here-string: a command containing a line that starts with `'@` would
  // close it early and turn the approval script into whatever that command wanted to run, outside
  // the gate this whole file exists to enforce.
  return [
    `$ErrorActionPreference='Stop'`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `Add-Type -AssemblyName System.Drawing`,
    `$q = ${psq(question)}`,
    `$cap = ${psq(caption)}`,
    `$ms = ${timeoutMs}`,
    `$script:timedOut = $false`,
    `[System.Windows.Forms.Application]::EnableVisualStyles()`,
    `$form = New-Object System.Windows.Forms.Form`,
    `$form.Text = $cap`,
    `$form.FormBorderStyle = 'FixedDialog'`,
    `$form.MaximizeBox = $false`,
    `$form.MinimizeBox = $false`,
    `$form.ShowInTaskbar = $true`,
    `$form.TopMost = $true`,
    `$form.StartPosition = 'CenterScreen'`,
    `try { $form.Font = [System.Windows.Forms.SystemInformation]::MessageBoxFont } catch {}`,
    `$w = 580`,
    `$body = New-Object System.Windows.Forms.Label`,
    `$body.AutoSize = $true`,
    `$body.MaximumSize = [System.Drawing.Size]::new($w - 40, 0)`,
    `$body.Location = [System.Drawing.Point]::new(20, 18)`,
    `$body.Text = $q`,
    `$form.Controls.Add($body) | Out-Null`,
    `$bh = $body.PreferredHeight`,
    `if ($bh -gt 300) {`,
    // A long command scrolls instead of pushing the buttons off the screen.
    `  $form.Controls.Remove($body)`,
    `  $tb = New-Object System.Windows.Forms.TextBox`,
    `  $tb.Multiline = $true`,
    `  $tb.ReadOnly = $true`,
    `  $tb.ScrollBars = 'Vertical'`,
    `  $tb.BorderStyle = 'None'`,
    `  $tb.BackColor = [System.Drawing.SystemColors]::Window`,
    `  $tb.Font = [System.Drawing.Font]::new('Consolas', 9)`,
    `  $tb.Location = [System.Drawing.Point]::new(20, 18)`,
    `  $tb.Size = [System.Drawing.Size]::new($w - 40, 300)`,
    `  $tb.Text = $q`,
    `  $form.Controls.Add($tb) | Out-Null`,
    `  $bh = 300`,
    `}`,
    `$by = 18 + $bh + 18`,
    `$always = New-Object System.Windows.Forms.Button`,
    `$always.Text = '总是允许这条'`,
    `$always.Location = [System.Drawing.Point]::new(20, $by)`,
    `$always.Size = [System.Drawing.Size]::new(160, 30)`,
    `$always.DialogResult = 'Yes'`,
    `$once = New-Object System.Windows.Forms.Button`,
    `$once.Text = '只这次允许'`,
    `$once.Location = [System.Drawing.Point]::new(190, $by)`,
    `$once.Size = [System.Drawing.Size]::new(160, 30)`,
    `$once.DialogResult = 'OK'`,
    `$deny = New-Object System.Windows.Forms.Button`,
    `$deny.Text = '拒绝'`,
    `$deny.Location = [System.Drawing.Point]::new(360, $by)`,
    `$deny.Size = [System.Drawing.Size]::new(100, 30)`,
    `$deny.DialogResult = 'Cancel'`,
    `$form.Controls.Add($always) | Out-Null`,
    `$form.Controls.Add($once) | Out-Null`,
    `$form.Controls.Add($deny) | Out-Null`,
    // Enter and Esc both land on 拒绝: the safe choice stays the default one.
    `$form.AcceptButton = $deny`,
    `$form.CancelButton = $deny`,
    `$form.ClientSize = [System.Drawing.Size]::new($w, $by + 30 + 16)`,
    `$timer = New-Object System.Windows.Forms.Timer`,
    `$timer.Interval = [Math]::Max(1000, $ms)`,
    `$timer.Add_Tick({ $script:timedOut = $true; $timer.Stop(); $form.Close() })`,
    `$timer.Start()`,
    `$picked = "$($form.ShowDialog())"`,
    `$timer.Stop()`,
    `$timer.Dispose()`,
    `$code = if ($script:timedOut) { 3 } elseif ($picked -eq 'Yes') { 2 } elseif ($picked -eq 'OK') { 1 } else { 0 }`,
    `[Console]::Out.Write($code)`,
  ].join('\n');
}

/**
 * Base64 of the UTF-16LE script, i.e. the value for pwsh's `-EncodedCommand`.
 *
 * Not `-Command -` over a pipe: that mode feeds stdin to the parser line by line, so a command
 * whose quoted text spans lines (a multi-line PowerShell command inside the question) dies
 * silently — exit code 0, no output, and no box. An argument keeps the script whole.
 */
export function encodeAskScript(question: string, caption: string, timeoutMs: number): string {
  return Buffer.from(script(question, caption, timeoutMs), 'utf16le').toString('base64');
}

export interface AskOptions {
  shell: string;
  caption?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Called when the dialog process ended without printing a recognizable answer code.
   *
   * A box that failed to build and a box someone refused both land on `no`, and from the caller's
   * side those look identical. Without this the only way to tell them apart is to reproduce it by
   * hand and ask a person what they saw on the screen.
   */
  onAnomaly?: (detail: Record<string, unknown>) => void;
}

const ANSWER_BY_CODE: Record<number, Answer> = {
  [ASK_CODE.no]: 'no',
  [ASK_CODE.yes]: 'yes',
  [ASK_CODE.always]: 'always',
  [ASK_CODE.timeout]: 'timeout',
};

/** Show the box and wait. Anything but an explicit allow is a refusal, including a failed spawn. */
export function askDesktop(question: string, opts: AskOptions): Promise<Answer> {
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(opts.shell, ['-NoProfile', '-NoLogo', '-NonInteractive', '-WindowStyle', 'Hidden', '-STA', '-EncodedCommand', encodeAskScript(question, opts.caption ?? 'Shell 确认', timeoutMs)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Not `windowsHide: true`. That startup flag suppresses the console window, and WinForms
        // honours it for the form too: the modal loop runs, the timer fires, and no box ever
        // appears. Hiding the console from inside PowerShell leaves the window itself visible.
        windowsHide: false,
      });
    } catch {
      resolve('no');
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const done = (a: Answer): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      resolve(a);
    };
    const onAbort = (): void => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      done('no');
    };
    // The box closes itself at `timeoutMs`; this backstop only covers a PowerShell that never returns
    // — which is what a form that never became visible looks like from here.
    const timer = setTimeout(() => {
      opts.onAnomaly?.({ stalled: true, timeoutMs });
      onAbort();
    }, timeoutMs + 15_000);
    opts.signal?.addEventListener('abort', onAbort);
    proc.stdout.on('data', (d) => { out += String(d); });
    proc.stderr.on('data', (d) => { err += String(d); });
    proc.on('error', () => done('no'));
    proc.on('exit', (code) => {
      // `Number('')` is 0, i.e. a clean 拒绝, so the code has to be matched as text first.
      const raw = out.trim();
      const a = /^[0-3]$/.test(raw) ? ANSWER_BY_CODE[Number(raw)] : undefined;
      if (!a) {
        // Empty or unreadable output: the form never got as far as showing itself, most likely.
        opts.onAnomaly?.({ exitCode: code, stdout: raw.slice(0, 200), stderr: err.trim().slice(-600) });
      }
      done(a ?? 'no');
    });
  });
}
