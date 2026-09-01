import { useEffect, useRef } from 'react';

/**
 * Listen for a USB/Bluetooth barcode scanner behaving as a keyboard wedge.
 *
 * A wedge scanner types its payload far faster than a person can and finishes with
 * Enter. Humans manage maybe 5-10 characters a second; a scanner does 100+. Timing
 * the gaps is what separates the two, so no dedicated input field is required and the
 * cashier can scan whatever is focused.
 *
 * If the burst landed in a text field on the way past, exactly those characters are
 * removed again — using the native value setter so React's onChange sees the update
 * rather than silently disagreeing with the DOM.
 *
 * @param {(code: string) => void} onScan
 * @param {object}  opts
 * The burst is judged by the MEDIAN gap between keystrokes, not the mean and not
 * every individual gap. That matters more than it sounds: the POS fetches inventory
 * on mount, and a single main-thread stall stretches one gap to several hundred
 * milliseconds. A per-gap limit throws the whole buffer away when that happens and
 * the scan is silently lost; a mean is dragged over the line by the same outlier.
 * A median shrugs it off — one slow gap among twelve fast ones changes nothing —
 * while still separating cleanly from human typing, which sits around 140 ms/char
 * against 1-15 ms for a wedge.
 *
 * @param {boolean} opts.enabled        turn the listener off entirely
 * @param {number}  opts.maxMedianMs    highest median ms/char still considered a scan
 * @param {number}  opts.idleResetMs    silence long enough to abandon a partial burst
 * @param {number}  opts.minLength      shorter bursts are ignored
 * @param {RegExp}  opts.pattern        what a payload may contain
 */
const DEFAULT_PATTERN = /^[0-9]+$/;

export default function useBarcodeScanner(onScan, {
  enabled = true,
  maxMedianMs = 50,
  idleResetMs = 2000,
  minLength = 6,
  pattern = DEFAULT_PATTERN,
} = {}) {
  // Refs, not state: this runs on every keystroke and must not re-render.
  const buf = useRef('');
  const gaps = useRef([]);
  const lastAt = useRef(0);
  const onScanRef = useRef(onScan);

  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  useEffect(() => {
    if (!enabled) return undefined;

    /** Strip the trailing `text` from a focused input, keeping React in sync. */
    function unwind(el, text) {
      if (!el || !text) return;
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;

      const value = el.value ?? '';
      if (!value.endsWith(text)) return; // something else changed it; leave it alone

      const next = value.slice(0, value.length - text.length);
      // React installs its own value setter on the element; calling the prototype's
      // setter directly is what makes the subsequent 'input' event look genuine.
      const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function onKeyDown(e) {
      // Never interfere with shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) { buf.current = ''; return; }

      const now = Date.now();
      const gap = now - lastAt.current;

      if (e.key === 'Enter') {
        const code = buf.current;
        const g = gaps.current.slice();
        buf.current = '';
        gaps.current = [];

        if (code.length < minLength || !pattern.test(code)) return;
        if (g.length === 0) return;

        const sorted = g.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        // A person cannot sustain a 50 ms median over six or more characters, so this
        // cannot fire on ordinary typing.
        if (median > maxMedianMs) return;

        e.preventDefault();
        e.stopPropagation();
        unwind(document.activeElement, code);
        onScanRef.current?.(code);
        return;
      }

      // Single printable character only; ignore Shift, Tab, arrows and the rest.
      if (e.key.length !== 1) {
        if (e.key !== 'Shift') { buf.current = ''; gaps.current = []; }
        return;
      }

      if (!lastAt.current || gap > idleResetMs) {
        // Nothing pending, or the buffer went stale — start fresh.
        buf.current = e.key;
        gaps.current = [];
      } else {
        buf.current += e.key;
        gaps.current.push(gap);
      }
      lastAt.current = now;
    }

    // Capture phase so the burst is seen before any component's own handler.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, maxMedianMs, idleResetMs, minLength, pattern]);
}
