/**
 * Whether to offer the print queue after receiving stock.
 *
 * Its own tiny module rather than a named export off the dialog, so the pages that only
 * need to ASK the question do not pull the dialog — and through it the label renderer —
 * into their chunk. Receiving a box should not download a barcode font.
 *
 * Stored per browser, not per user: it is a preference about this till's workflow ("we
 * print at this desk, don't ask"), and the same person at the back office may well want
 * the prompt. Every read and write is wrapped, because localStorage throws outright in
 * a private window rather than returning null.
 */

export const PROMPT_OFF_KEY = 'print_queue_prompt_off';

/** Has the operator asked not to be offered the queue after receiving stock? */
export function promptSuppressed() {
  try { return localStorage.getItem(PROMPT_OFF_KEY) === '1'; } catch { return false; }
}

export function setPromptSuppressed(off) {
  try { localStorage.setItem(PROMPT_OFF_KEY, off ? '1' : '0'); } catch { /* private mode */ }
}
