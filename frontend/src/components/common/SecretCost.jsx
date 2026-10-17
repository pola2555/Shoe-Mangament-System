import { useEffect, useRef, useState } from 'react';
import { useCostReveal } from '../../context/CostRevealContext';
import { useTranslation } from '../../i18n/i18nContext';
import './SecretCost.css';

/**
 * A cost figure, blurred until somebody asks for it.
 *
 * Press and hold to read one value; let go and it hides again. The page's eye button
 * shows all of them at once for as long as it is on.
 *
 * WHY A HOLD rather than a click. A click toggles, and a toggle left on is exactly
 * what this is for — a cost sitting uncovered on a screen nobody is looking at. A hold
 * cannot be left on: it ends when the finger lifts, including when the finger lifts
 * because somebody walked away. The short delay before it opens is what stops a stray
 * tap while scrolling from flashing the number.
 *
 * `userSelect: none` and the suppressed context menu matter more than they look: on a
 * phone, a long press on text is the gesture for "select and copy", and without them
 * the hold that reveals the cost also raises a selection bubble over it.
 */
export default function SecretCost({
  children, className = '', holdMs = 400, 'data-testid': testId,
}) {
  const { revealAll } = useCostReveal();
  const { t } = useTranslation();
  const [held, setHeld] = useState(false);
  const timer = useRef(null);

  // A press that never gets its release — the pointer left the window, the component
  // unmounted mid-hold — must not leave a timer running into a dead component.
  useEffect(() => () => clearTimeout(timer.current), []);

  const open = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHeld(true), holdMs);
  };
  const close = () => {
    clearTimeout(timer.current);
    setHeld(false);
  };

  const shown = revealAll || held;

  return (
    <span
      className={`secret-cost ${shown ? 'secret-cost--shown' : ''} ${className}`}
      data-testid={testId}
      data-revealed={shown ? 'true' : 'false'}
      onPointerDown={open}
      onPointerUp={close}
      onPointerLeave={close}
      onPointerCancel={close}
      onContextMenu={(e) => e.preventDefault()}
      // Not a button: it carries a value, and announcing "button" to a screen reader
      // would be a lie. The title says how to open it for anybody who hovers.
      title={shown ? undefined : t('products.hold_to_reveal')}
    >
      {children}
    </span>
  );
}
