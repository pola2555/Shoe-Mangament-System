import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { shiftsAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';

/**
 * Whether this till has a drawer open, shown where a cashier will actually see it.
 *
 * SELLING WITHOUT A SHIFT IS ALLOWED
 *
 * Blocking it would stop a shop trading because of paperwork, which is never the right
 * trade. But that money then belongs to no cash-up and nothing checks it, so the state
 * has to be visible at the till rather than discovered a week later in a report.
 *
 * Hence: a quiet strip when a shift is open, and a loud one with a button when it is
 * not. Opening takes one number — what is in the drawer right now.
 */
export default function ShiftBanner({ storeId, onChange }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canRun = hasPermission('shifts', 'write');

  const [shift, setShift] = useState(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [float, setFloat] = useState('');

  const load = useCallback(async () => {
    if (!storeId) { setShift(null); setLoading(false); return; }
    try {
      const { data } = await shiftsAPI.current(storeId);
      setShift(data.data);
      onChange?.(data.data);
    } catch {
      setShift(null);
    } finally {
      setLoading(false);
    }
  }, [storeId, onChange]);

  useEffect(() => { load(); }, [load]);

  const open = async () => {
    const value = Number(float);
    if (!Number.isFinite(value) || value < 0) { toast.error(t('shifts.float_required')); return; }
    try {
      await shiftsAPI.open({ store_id: storeId, opening_float: value });
      toast.success(t('shifts.opened'));
      setOpening(false);
      setFloat('');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  if (loading || !storeId) return null;

  if (shift) {
    return (
      <div className="pos-shift-strip pos-shift-strip--open" data-testid="pos-shift-open">
        <span>
          {t('shifts.open_here', {
            number: shift.shift_number,
            amount: (Math.round((shift.position?.expected_cash || 0) * 100) / 100).toLocaleString(),
          })}
        </span>
        <Link className="btn btn-sm btn-secondary" to="/shifts">{t('shifts.go_to_till')}</Link>
      </div>
    );
  }

  return (
    <div className="pos-shift-strip pos-shift-strip--closed" data-testid="pos-shift-closed">
      <span>{t('shifts.none_open_here')}</span>
      {canRun && (opening ? (
        <span className="pos-shift-open-inline">
          <input type="number" step="0.01" min="0" className="form-input"
            placeholder={t('shifts.float_placeholder')} data-testid="pos-shift-float"
            value={float} onChange={(e) => setFloat(e.target.value)} />
          <button className="btn btn-sm btn-primary" onClick={open} data-testid="pos-shift-open-submit">
            {t('shifts.start_shift')}
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => setOpening(false)}>
            {t('common.cancel')}
          </button>
        </span>
      ) : (
        <button className="btn btn-sm btn-primary" onClick={() => setOpening(true)}
          data-testid="pos-shift-start">
          {t('shifts.start_shift')}
        </button>
      ))}
    </div>
  );
}
