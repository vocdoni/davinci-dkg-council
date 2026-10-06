/** File download and print helpers (no third-party code, no network). */

export function downloadTextFile(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Open the browser print dialog over a plain-text sheet, via a hidden
 * same-origin iframe (a `window.open` popup can be blocked or, with
 * `noopener`, returns null — the attempt would silently do nothing).
 * Returns false when printing could not be started; callers must not treat
 * a failed attempt as "saved".
 */
export function printTextSheet(title: string, body: string): boolean {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win || typeof win.print !== 'function') throw new Error('no print');
    doc.title = title;
    const pre = doc.createElement('pre');
    pre.style.fontFamily = 'ui-monospace, monospace';
    pre.style.fontSize = '14px';
    pre.style.padding = '24px';
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = body;
    doc.body.appendChild(pre);
    win.focus();
    win.print();
    // Leave the frame around while the (modal) dialog may still read it.
    setTimeout(() => frame.remove(), 60_000);
    return true;
  } catch {
    frame.remove();
    return false;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
