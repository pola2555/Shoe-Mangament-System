import { useState, useEffect } from 'react';

/**
 * Is the viewport narrow enough that a wide grid has to become a list?
 *
 * A media query rather than a user-agent sniff: what matters is how much room there
 * is, not what kind of device is asking. A phone held sideways and a narrow desktop
 * window have the same problem and deserve the same answer.
 *
 * 768px to match the breakpoint the rest of the app already uses, so the layout does
 * not change shape at a width nothing else reacts to.
 *
 * Answers false during the first render on a server or in a test environment without
 * matchMedia, then corrects itself on mount — the wide layout is the safe default
 * because it is the one that works at every size, just badly at small ones.
 */
export default function useIsNarrow(maxWidth = 768) {
  const query = `(max-width: ${maxWidth}px)`;

  const [narrow, setNarrow] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);          // in case it changed between render and mount
    // addEventListener on a MediaQueryList is unsupported in older Safari, which
    // still has the deprecated addListener. A rotation that silently stops being
    // noticed is exactly the bug this guards against.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [query]);

  return narrow;
}
