import { useEffect } from 'react';

/**
 * Stop the mouse wheel from editing a focused number input.
 *
 * A browser treats a wheel over a focused `<input type="number">` as a value change.
 * On a long invoice — where the cost and quantity boxes are exactly what you scroll
 * past — that silently rewrites money, and nothing on screen says it happened. This is
 * the single most damaging small bug in the app: it produces wrong data that looks
 * deliberate.
 *
 * There are 47 such inputs across 18 files, and more will be added. Guarding them
 * individually means the next one is unguarded, so this is one listener for all of them
 * and for anything added later.
 *
 * WHY blur() AND NOT preventDefault()
 *
 * preventDefault on the wheel stops the value changing, but it also stops the PAGE
 * scrolling — the pointer sits over an input and the form appears frozen. Blurring the
 * input removes it from the wheel's path instead: the value is safe and the scroll
 * carries on as normal. Losing focus is the correct signal anyway; the user was
 * scrolling, not typing.
 *
 * Capture phase, so it runs before React's synthetic handlers and before the browser's
 * own default. Passive, because nothing here calls preventDefault.
 */
export default function useNumberScrollGuard() {
  useEffect(() => {
    const onWheel = (event) => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'INPUT' || el.type !== 'number') return;
      // Only when the wheel is actually over the focused field. Scrolling elsewhere on
      // the page must not steal focus from something being typed into.
      if (el !== event.target && !el.contains(event.target)) return;
      el.blur();
    };

    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => document.removeEventListener('wheel', onWheel, { capture: true });
  }, []);
}
