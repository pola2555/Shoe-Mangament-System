import { useCostReveal } from '../../context/CostRevealContext';
import { useTranslation } from '../../i18n/i18nContext';
import './SecretCost.css';

/**
 * The eye: show every cost on this page, or hide them again.
 *
 * Holding each value one at a time is right for a glance at one product and hopeless
 * for a stock list of forty, so the page carries a switch for when costing IS the job.
 *
 * It says which state it is in rather than which action it offers — "Costs shown" when
 * they are — because the blur itself already tells you the current state, and a button
 * labelled for its action next to content that contradicts it is how people end up
 * pressing it twice.
 *
 * It goes back to hidden whenever the page changes; see `CostRevealContext` for why.
 */
export default function CostRevealToggle({ className = '' }) {
  const { revealAll, setRevealAll } = useCostReveal();
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={`btn btn-sm ${revealAll ? 'btn-primary' : 'btn-secondary'} cost-eye ${className}`}
      data-testid="cost-reveal-toggle"
      aria-pressed={revealAll}
      onClick={() => setRevealAll((v) => !v)}
      title={revealAll ? t('products.costs_shown') : t('products.costs_hidden')}
    >
      <span aria-hidden="true">{revealAll ? '👁' : '🙈'}</span>
      <span>{revealAll ? t('products.costs_shown') : t('products.show_costs')}</span>
    </button>
  );
}
