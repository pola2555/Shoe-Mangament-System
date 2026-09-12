import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { stockCountsAPI, storesAPI, productsAPI, productCategoriesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import { useConfirm } from '../../components/common/ConfirmDialog';
import SearchableSelect from '../../components/common/SearchableSelect';
import { formatSize, formatColor } from '../../utils/variantFormat';
import '../products/Products.css';
import './StockIntake.css';
import './StockCount.css';

/**
 * Counting the shelf.
 *
 * WHY THE EXPECTED NUMBER IS ON SCREEN HERE, AND HIDDEN IN THE CASH-UP
 *
 * Opposite problems. Cash is one number and showing the expected figure first turns a
 * count into a rubber stamp. Stock is hundreds of numbers, and a counter walking the
 * shelf needs to know which line they are on — hiding it would just mean printing the
 * sheet and typing it back in afterwards.
 *
 * What protects the count instead is that `expected_qty` was FROZEN when the sheet was
 * made. The shop keeps trading while somebody counts, so a live comparison would report
 * two days of ordinary sales as shrinkage.
 *
 * A BLANK IS NOT A ZERO
 *
 * Lines left empty are skipped when the sheet is posted. That is the difference between
 * counting one shelf and writing off the rest of the shop, so the screen says so and
 * the count of "still to do" is always visible.
 */

const money = (v) => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString();

export default function StockCountPage() {
  const { t, locale } = useTranslation();
  const confirm = useConfirm();
  const { filterStores, hasPermission } = useAuth();
  const canWrite = hasPermission('stock_count', 'write');

  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState(null);
  const [counts, setCounts] = useState({});     // variant_id -> string
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ scope: 'full', category_id: '', product_id: '', notes: '' });
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [onlyPending, setOnlyPending] = useState(false);
  const [search, setSearch] = useState('');

  const myStores = useMemo(() => filterStores(stores || []), [stores, filterStores]);

  useEffect(() => {
    storesAPI.list().then(({ data }) => {
      const all = data.data || [];
      setStores(all);
      const mine = filterStores(all);
      if (mine.length && !storeId) setStoreId(mine[0].id);
    }).catch(() => {});
    productCategoriesAPI.list().then(({ data }) => setCategories(data.data || [])).catch(() => {});
    productsAPI.list({ is_active: true }).then(({ data }) => setProducts(data.data || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!storeId) { setLoading(false); return; }
    try {
      setLoading(true);
      const { data } = await stockCountsAPI.list({ store_id: storeId });
      setList(data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed_to_load'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => { load(); }, [load]);

  const openSheet = async (id) => {
    try {
      const { data } = await stockCountsAPI.getById(id);
      setSheet(data.data);
      setCounts(Object.fromEntries(
        (data.data.lines || []).map((l) => [l.variant_id, l.counted_qty ?? ''])
      ));
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const startCount = async (e) => {
    e.preventDefault();
    try {
      const { data } = await stockCountsAPI.create({
        store_id: storeId,
        scope: newForm.scope,
        category_id: newForm.scope === 'category' ? newForm.category_id : null,
        product_id: newForm.scope === 'product' ? newForm.product_id : null,
        notes: newForm.notes,
      });
      setShowNew(false);
      setNewForm({ scope: 'full', category_id: '', product_id: '', notes: '' });
      await load();
      await openSheet(data.data.id);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const saveCounts = async () => {
    try {
      const lines = Object.entries(counts).map(([variant_id, v]) => ({
        variant_id,
        counted_qty: v === '' || v === null ? null : Number(v),
      }));
      const { data } = await stockCountsAPI.setCounts(sheet.id, lines);
      setSheet(data.data);
      toast.success(t('common.saved'));
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const postCount = async () => {
    // Posting writes stock off. The numbers it is about to move are shown IN the
    // dialog rather than described in a sentence: a count that loses forty pairs and
    // one that loses a single pair both used to read "Are you sure?".
    const ok = await confirm({
      title: t('count.post_confirm_title'),
      message: t('count.post_confirm'),
      danger: progress.lost > 0,
      confirmText: t('count.post'),
      facts: [
        { label: t('count.counted'), value: `${progress.done} / ${progress.total}` },
        { label: t('count.found'), value: `+${progress.found}` },
        { label: t('count.lost'), value: `-${progress.lost}`, danger: progress.lost > 0 },
        ...(progress.done < progress.total
          ? [{ label: t('count.blank_skipped_n'), value: progress.total - progress.done }]
          : []),
      ],
    });
    if (!ok) return;
    try {
      await saveCounts();
      const { data } = await stockCountsAPI.post(sheet.id);
      const s = data.data.summary;
      toast.success(t('count.posted', { found: s.found, lost: s.lost }));
      setSheet(data.data);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const rows = useMemo(() => {
    if (!sheet) return [];
    let out = sheet.lines || [];
    if (onlyPending) out = out.filter((l) => counts[l.variant_id] === '' || counts[l.variant_id] === null);
    if (search) {
      const q = search.toLowerCase();
      out = out.filter((l) => [l.product_code, l.product_name, l.color_name, l.size_eu, l.sku, l.barcode]
        .some((f) => String(f || '').toLowerCase().includes(q)));
    }
    return out;
  }, [sheet, counts, onlyPending, search]);

  const progress = useMemo(() => {
    if (!sheet) return { done: 0, total: 0, found: 0, lost: 0 };
    let done = 0; let found = 0; let lost = 0;
    for (const l of sheet.lines || []) {
      const v = counts[l.variant_id];
      if (v === '' || v === null || v === undefined) continue;
      done++;
      const variance = Number(v) - l.expected_qty;
      if (variance > 0) found += variance;
      if (variance < 0) lost += -variance;
    }
    return { done, total: (sheet.lines || []).length, found, lost };
  }, [sheet, counts]);

  const isDraft = sheet?.status === 'draft';

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('count.title')}</h1>
          <p className="section-hint">{t('count.page_hint')}</p>
        </div>
        <div className="intake-filters" style={{ marginBottom: 0 }}>
          <select className="form-input" value={storeId} onChange={(e) => { setStoreId(e.target.value); setSheet(null); }}>
            {myStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {canWrite && (
            <button className="btn btn-primary" onClick={() => setShowNew(true)} data-testid="count-new">
              {`+ ${t('count.new')}`}
            </button>
          )}
        </div>
      </div>

      {!sheet && (loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>#</th><th>{t('common.date')}</th><th>{t('count.scope')}</th>
                <th>{t('count.progress')}</th><th>{t('count.found')}</th><th>{t('count.lost')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr><td colSpan={7} className="section-hint">{t('count.none')}</td></tr>
              )}
              {list.map((c) => (
                <tr key={c.id} className="product-row" data-testid={`count-row-${c.id}`} onClick={() => openSheet(c.id)}>
                  <td><strong>{c.count_number}</strong></td>
                  <td>{String(c.counted_at || c.created_at).slice(0, 10)}</td>
                  <td>{t(`count.scope_${c.scope}`)}</td>
                  <td>{c.counted_lines}/{c.line_count}</td>
                  <td>{c.found > 0 ? <span className="shift-good">+{c.found}</span> : '—'}</td>
                  <td>{c.lost > 0 ? <span className="shift-bad">-{c.lost}</span> : '—'}</td>
                  <td>
                    <span className={`badge ${c.status === 'posted' ? 'badge-success'
                      : c.status === 'cancelled' ? 'badge-danger' : 'badge-warning'}`}>
                      {t(`count.status_${c.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* ------------------------------------------------ the sheet */}
      {sheet && (
        <div className="card">
          <div className="count-head">
            <div>
              <h2>
                {sheet.count_number}{' '}
                <span className={`badge ${sheet.status === 'posted' ? 'badge-success'
                  : sheet.status === 'cancelled' ? 'badge-danger' : 'badge-warning'}`}>
                  {t(`count.status_${sheet.status}`)}
                </span>
              </h2>
              <p className="section-hint">{t('count.frozen_hint')}</p>
            </div>
            <button className="btn btn-secondary" onClick={() => setSheet(null)}>{t('common.back')}</button>
          </div>

          <div className="shift-grid">
            <div className="shift-cell">
              <div className="shift-cell-label">{t('count.progress')}</div>
              <div className="shift-cell-value">{progress.done} / {progress.total}</div>
              <div className="shift-cell-sub">{t('count.blank_is_skipped')}</div>
            </div>
            <div className="shift-cell">
              <div className="shift-cell-label">{t('count.found')}</div>
              <div className="shift-cell-value shift-good">+{progress.found}</div>
            </div>
            <div className="shift-cell">
              <div className="shift-cell-label">{t('count.lost')}</div>
              <div className="shift-cell-value shift-bad">-{progress.lost}</div>
            </div>
          </div>

          <div className="intake-filters">
            <input className="form-input" placeholder={t('count.search')} value={search}
              onChange={(e) => setSearch(e.target.value)} />
            <label className="intake-known">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              <span>{t('count.only_uncounted')}</span>
            </label>
          </div>

          <div className="table-container count-table">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.product')}</th><th>{t('common.color')}</th><th>{t('common.size')}</th>
                  <th>{t('count.expected')}</th><th>{t('count.counted')}</th><th>{t('count.variance')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const v = counts[l.variant_id];
                  const counted = v !== '' && v !== null && v !== undefined;
                  const variance = counted ? Number(v) - l.expected_qty : null;
                  return (
                    <tr key={l.variant_id} data-testid={`count-line-${l.variant_id}`}>
                      <td>
                        <strong>{l.product_code}</strong>
                        <div className="count-sub">{l.product_name}</div>
                      </td>
                      <td>{formatColor(l) || '—'}</td>
                      <td>{formatSize(l, locale)}</td>
                      <td>{l.expected_qty}</td>
                      <td>
                        <input type="number" min="0" className="form-input count-input"
                          disabled={!isDraft || !canWrite}
                          value={v ?? ''}
                          onChange={(e) => setCounts({ ...counts, [l.variant_id]: e.target.value })} />
                      </td>
                      <td className={variance > 0 ? 'shift-good' : variance < 0 ? 'shift-bad' : ''}>
                        {variance === null ? '—' : variance > 0 ? `+${variance}` : variance}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {isDraft && canWrite && (
            <div className="form-actions" style={{ marginTop: 'var(--spacing-lg)' }}>
              <button className="btn btn-secondary" onClick={saveCounts}>{t('common.save')}</button>
              <button className="btn btn-primary" onClick={postCount} data-testid="count-post">
                {t('count.post')}
              </button>
            </div>
          )}
          {sheet.status === 'posted' && (
            <p className="section-hint" style={{ marginTop: 'var(--spacing-md)' }}>
              {t('count.posted_note')}
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------ new count */}
      {showNew && (
        <div className="modal-overlay" onClick={() => setShowNew(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2>{t('count.new')}</h2>
            <p className="section-hint">{t('count.new_hint')}</p>
            <form onSubmit={startCount} className="product-form">
              <div className="form-group">
                <label className="form-label">{t('count.scope')}</label>
                <select className="form-input" value={newForm.scope}
                  onChange={(e) => setNewForm({ ...newForm, scope: e.target.value })}>
                  {['full', 'category', 'product'].map((s) => (
                    <option key={s} value={s}>{t(`count.scope_${s}`)}</option>
                  ))}
                </select>
              </div>
              {newForm.scope === 'category' && (
                <div className="form-group">
                  <label className="form-label">{t('products.category')}</label>
                  <select className="form-input" required value={newForm.category_id}
                    onChange={(e) => setNewForm({ ...newForm, category_id: e.target.value })}>
                    <option value="">{t('common.select')}</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name_en}</option>)}
                  </select>
                </div>
              )}
              {newForm.scope === 'product' && (
                <div className="form-group">
                  <label className="form-label">{t('common.product')}</label>
                  <SearchableSelect
                    options={products.map((p) => ({ value: p.id, label: `${p.product_code} — ${p.model_name}` }))}
                    value={newForm.product_id}
                    onChange={(e) => setNewForm({ ...newForm, product_id: e.target.value })}
                    placeholder={t('intake.pick_product')}
                  />
                </div>
              )}
              <div className="form-group">
                <label className="form-label">{t('common.notes')}</label>
                <input className="form-input" value={newForm.notes}
                  onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowNew(false)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary">{t('count.start')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
