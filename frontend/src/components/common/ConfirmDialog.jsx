import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from '../../i18n/i18nContext';

/**
 * ASKING THE USER SOMETHING, IN THE APP'S OWN VOICE.
 *
 * `window.confirm` and `window.prompt` were used in eleven places, including three that
 * decide money: posting a stock count, reversing a stock intake, and re-costing a
 * product. They are the wrong tool here for reasons that are not cosmetic:
 *
 *   - They cannot be translated. The OK/Cancel buttons come from the browser in the
 *     browser's language, so an Arabic UI asked its question in Arabic and offered its
 *     buttons in English.
 *   - They cannot say what is about to happen. A stock count that is about to write off
 *     forty pairs deserves to show that number in red, not a line of text.
 *   - They are modal to the whole browser, so nothing behind them can be read while
 *     deciding — often exactly the thing being asked about.
 *   - `prompt` returns a raw string with no validation, no units and no type; the
 *     re-cost dialog took a price that way.
 *   - Some browsers let a user tick "prevent this page from creating more dialogs",
 *     after which every subsequent confirm silently returns false. A delete then does
 *     nothing, with no error and no explanation.
 *
 * Usage — the hook returns a promise, so a call site reads almost exactly as it did:
 *
 *     const confirm = useConfirm();
 *     if (!await confirm({ title: t('...'), message: t('...'), danger: true })) return;
 *
 *     const value = await confirm.prompt({ title: ..., type: 'number', initial: '0' });
 *     if (value === null) return;            // cancelled; '' is a legitimate answer
 */

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const { t } = useTranslation();
  const [state, setState] = useState(null);
  const resolver = useRef(null);
  const inputRef = useRef(null);

  const close = useCallback((value) => {
    setState(null);
    if (resolver.current) {
      resolver.current(value);
      resolver.current = null;
    }
  }, []);

  const ask = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setState({ mode: 'confirm', ...opts, value: '' });
  }), []);

  // A prompt is the same dialog with a field in it, so cancelling behaves identically
  // and there is one place that can be styled, translated and tested.
  ask.prompt = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setState({ mode: 'prompt', type: 'text', ...opts, value: opts.initial ?? '' });
  }), []);

  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close(state.mode === 'prompt' ? null : false);
      // Enter confirms, except in a textarea where it is a newline.
      if (e.key === 'Enter' && e.target?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        close(state.mode === 'prompt' ? (inputRef.current?.value ?? '') : true);
      }
    };
    window.addEventListener('keydown', onKey);
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 40);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(focusTimer); };
  }, [state, close]);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {state && (
        <div className="modal-overlay" data-testid="confirm-overlay"
          onClick={() => close(state.mode === 'prompt' ? null : false)}>
          <div className="modal-content card" style={{ maxWidth: 460 }}
            data-testid="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-sm)' }} data-testid="confirm-title">
              {state.title || t('common.are_you_sure')}
            </h2>

            {state.message && (
              <p className="section-hint" data-testid="confirm-message"
                style={{ whiteSpace: 'pre-line' }}>
                {state.message}
              </p>
            )}

            {/* The numbers the decision actually turns on, when a caller supplies them.
                A write-off of forty pairs should look different from one pair. */}
            {Array.isArray(state.facts) && state.facts.length > 0 && (
              <div className="confirm-facts" data-testid="confirm-facts">
                {state.facts.map((f) => (
                  <div key={f.label} className={`confirm-fact${f.danger ? ' confirm-fact--danger' : ''}`}>
                    <span>{f.label}</span>
                    <strong>{f.value}</strong>
                  </div>
                ))}
              </div>
            )}

            {state.mode === 'prompt' && (
              <div className="form-group" style={{ marginTop: 'var(--spacing-md)' }}>
                {state.label && <label className="form-label">{state.label}</label>}
                <input
                  ref={inputRef}
                  className="form-input"
                  data-testid="confirm-input"
                  type={state.type}
                  step={state.type === 'number' ? (state.step || '0.01') : undefined}
                  min={state.type === 'number' ? state.min : undefined}
                  placeholder={state.placeholder || ''}
                  defaultValue={state.value}
                />
                {state.hint && <div className="form-hint">{state.hint}</div>}
              </div>
            )}

            <div className="form-actions" style={{ marginTop: 'var(--spacing-lg)' }}>
              <button type="button" className="btn btn-secondary" data-testid="confirm-cancel"
                onClick={() => close(state.mode === 'prompt' ? null : false)}>
                {state.cancelText || t('common.cancel')}
              </button>
              <button type="button"
                className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
                data-testid="confirm-ok"
                ref={state.mode === 'confirm' ? inputRef : undefined}
                onClick={() => close(state.mode === 'prompt' ? (inputRef.current?.value ?? '') : true)}>
                {state.confirmText || t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * Returns an async `confirm(opts)` with a `.prompt(opts)` on it.
 *
 * Falls back to the browser's own dialogs if the provider is missing, so a component
 * rendered outside it degrades instead of throwing — but every screen in this app is
 * inside it.
 */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (ctx) return ctx;
  const fallback = async (opts) => window.confirm(opts?.message || opts?.title || '');
  fallback.prompt = async (opts) => window.prompt(opts?.title || '', opts?.initial ?? '');
  return fallback;
}

export default ConfirmProvider;
