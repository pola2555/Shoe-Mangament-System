import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { stockIntakesAPI, productsAPI, suppliersAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import { useConfirm } from '../../components/common/ConfirmDialog';
import SearchableSelect from '../../components/common/SearchableSelect';
import useProductCategory from '../../hooks/useProductCategory';
import { formatSize, formatColor } from '../../utils/variantFormat';
import '../products/Products.css';
import './StockIntake.css';

/**
 * One stock intake sheet.
 *
 * A draft changes nothing. Posting is the moment stock exists — which is why Post is a
 * separate button and not a side effect of saving, and why a 300-pair opening count can
 * be typed over an afternoon and checked before it lands.
 *
 * THE COST IS THE POINT OF THIS SCREEN
 *
 * `inventory_items.cost` is what profit is computed from. Old stock entered at zero
 * makes every sale of it read as pure margin, and nothing on any screen would say so.
 * So a line always carries a cost, and it is marked as a GUESS unless the owner says
 * otherwise. Two ways to fill it, in order of how much they can be trusted:
 *
 *   1. a real invoiced cost for that product, if the system already has one
 *   2. worked back from the selling price at a margin the owner states once
 *
 * A guess is replaced automatically the next time that product is bought on a real
 * invoice. A line ticked "I know this cost" never is — it is history from the moment it
 * is entered.
 */

const REASONS = ['opening', 'count', 'found', 'damaged'];
const MARGIN_KEY = 'intake_margin_pct';

const money = (v) => (v == null || v === '' ? '—' : `${Number(v).toLocaleString()} EGP`);

export default function StockIntakeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, locale } = useTranslation();
  const confirm = useConfirm();
  const { filterStores, hasPermission } = useAuth();
  const canWrite = hasPermission('stock_intake', 'write');

  const [intake, setIntake] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stores, setStores] = useState([]);
  const [saving, setSaving] = useState(false);
  const [header, setHeader] = useState({
    store_id: '', supplier_id: '', reason: 'opening', intake_date: '', notes: '',
  });
  const [lines, setLines] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);

  // The add-stock panel
  const [pickedProduct, setPickedProduct] = useState('');
  const [grid, setGrid] = useState({});          // `${colorId}|${size}` -> qty
  const [unitCost, setUnitCost] = useState('');
  const [known, setKnown] = useState(false);
  const [hint, setHint] = useState(null);
  const [margin, setMargin] = useState(() => {
    try { return localStorage.getItem(MARGIN_KEY) || '40'; } catch { return '40'; }
  });

  const cat = useProductCategory(pickedProduct);
  const isDraft = intake?.status === 'draft';
  const myStores = useMemo(() => filterStores(stores || []), [stores, filterStores]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await stockIntakesAPI.getById(id);
      const sheet = data.data;
      setIntake(sheet);
      setHeader({
        store_id: sheet.store_id || '',
        supplier_id: sheet.supplier_id || '',
        reason: sheet.reason || 'opening',
        intake_date: (sheet.intake_date || '').slice(0, 10),
        notes: sheet.notes || '',
      });
      setLines((sheet.lines || []).map((l) => ({
        product_id: l.product_id,
        product_color_id: l.product_color_id,
        size_eu: l.size_eu,
        quantity: Number(l.quantity),
        unit_cost: Number(l.unit_cost),
        cost_is_estimated: l.cost_is_estimated,
        // Display only — the server re-derives everything it needs from the ids.
        _product: `${l.product_code} · ${l.product_name}`,
        _color: formatColor(l) || '',
        _size: formatSize(l, locale),
      })));
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed_to_load'));
      navigate('/stock-intakes');
    } finally {
      setLoading(false);
    }
  }, [id, locale, navigate, t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    storesAPI.list().then(({ data }) => setStores(data.data || [])).catch(() => {});
    suppliersAPI.list().then(({ data }) => setSuppliers(data.data || [])).catch(() => {});
    productsAPI.list({ is_active: true }).then(({ data }) => setProducts(data.data || [])).catch(() => {});
  }, []);

  // A real invoiced cost beats any guess, so it is fetched the moment a product is
  // picked rather than waiting for the owner to ask for it.
  useEffect(() => {
    if (!pickedProduct) { setHint(null); return; }
    stockIntakesAPI.costHint({ product_id: pickedProduct })
      .then(({ data }) => {
        setHint(data.data);
        if (data.data.unit_cost != null) {
          setUnitCost(String(data.data.unit_cost));
          setKnown(true);      // it came off an invoice; it is not a guess
        } else {
          setUnitCost('');
          setKnown(false);
        }
      })
      .catch(() => setHint(null));
  }, [pickedProduct]);

  const productOptions = useMemo(() => products.map((p) => ({
    value: p.id, label: `${p.product_code} — ${p.brand ? p.brand + ' ' : ''}${p.model_name}`,
  })), [products]);

  const fillFromMargin = () => {
    const sell = Number(hint?.default_selling_price);
    const pct = Number(margin);
    if (!sell || !Number.isFinite(pct) || pct <= -100) {
      toast.error(t('intake.no_selling_price'));
      return;
    }
    try { localStorage.setItem(MARGIN_KEY, String(pct)); } catch { /* private mode */ }
    setUnitCost(String(Math.round((sell / (1 + pct / 100)) * 100) / 100));
    setKnown(false);           // worked back from a price is a guess, by definition
  };

  // Colour rows and size columns for the picked product. A colourless category gets one
  // unnamed row and a sizeless one gets a single column, so the same grid serves a shoe,
  // a sock, a belt and a knife without four code paths.
  const colorRows = cat.hasColors && cat.colors.length
    ? cat.colors
    : [{ id: null, color_name: '' }];
  const sizeCols = cat.hasSizes && cat.sizeValues.length
    ? cat.sizeValues
    : [{ value: null, label_en: t('intake.one_size'), label_ar: t('intake.one_size') }];

  const addToSheet = () => {
    const cost = Number(unitCost);
    if (!Number.isFinite(cost) || cost < 0) { toast.error(t('intake.cost_required')); return; }

    const product = products.find((p) => p.id === pickedProduct);
    const added = [];
    for (const c of colorRows) {
      for (const s of sizeCols) {
        const qty = parseInt(grid[`${c.id}|${s.value}`], 10);
        if (!Number.isFinite(qty) || qty < 1) continue;
        added.push({
          product_id: pickedProduct,
          product_color_id: c.id,
          size_eu: s.value,
          quantity: qty,
          unit_cost: cost,
          cost_is_estimated: !known,
          _product: `${product.product_code} · ${product.model_name}`,
          _color: c.color_name || '',
          _size: s.value
            ? formatSize({ size_eu: s.value, size_label_en: s.label_en, size_label_ar: s.label_ar,
                           size_prefix: cat.prefix, has_sizes: cat.hasSizes }, locale)
            : t('intake.one_size'),
        });
      }
    }
    if (!added.length) { toast.error(t('intake.nothing_to_add')); return; }

    setLines((prev) => [...prev, ...added]);
    setGrid({});
    toast.success(t('intake.lines_added', { n: added.length }));
  };

  const save = async ({ thenPost } = {}) => {
    try {
      setSaving(true);
      await stockIntakesAPI.update(id, {
        ...header,
        supplier_id: header.supplier_id || null,
        lines: lines.map(({ _product, _color, _size, ...l }) => l),
      });
      if (thenPost) {
        await stockIntakesAPI.post(id);
        toast.success(t('intake.posted_ok'));
      } else {
        toast.success(t('common.saved'));
      }
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally {
      setSaving(false);
    }
  };

  const reverse = async () => {
    const reason = await confirm.prompt({
      title: t('intake.reverse_title'),
      message: t('intake.reverse_reason'),
      label: t('common.reason'),
      danger: true,
      confirmText: t('intake.reverse'),
    });
    if (reason === null) return;
    try {
      await stockIntakesAPI.reverse(id, reason);
      toast.success(t('intake.reversed_ok'));
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const remove = async () => {
    if (!await confirm({
      title: t('intake.delete_title'),
      message: t('intake.delete_confirm'),
      danger: true,
      confirmText: t('common.delete'),
    })) return;
    try {
      await stockIntakesAPI.delete(id);
      toast.success(t('common.deleted'));
      navigate('/stock-intakes');
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const totals = useMemo(() => lines.reduce((acc, l) => ({
    units: acc.units + Number(l.quantity),
    value: acc.value + Number(l.quantity) * Number(l.unit_cost),
    guessed: acc.guessed + (l.cost_is_estimated ? Number(l.quantity) : 0),
  }), { units: 0, value: 0, guessed: 0 }), [lines]);

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!intake) return null;

  const badgeClass = intake.status === 'posted' ? 'badge-success'
    : intake.status === 'cancelled' ? 'badge-danger' : 'badge-warning';

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {intake.intake_number}{' '}
            <span className={`badge ${badgeClass}`}>{t(`intake.status_${intake.status}`)}</span>
          </h1>
          <p className="section-hint">{t('intake.detail_hint')}</p>
        </div>
        <button className="btn btn-secondary" onClick={() => navigate('/stock-intakes')}>
          {t('common.back')}
        </button>
      </div>

      {/* ---------------------------------------------------------------- header */}
      <div className="card" style={{ marginBottom: 'var(--spacing-lg)' }}>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">{t('common.store')} *</label>
            <select className="form-input" value={header.store_id} disabled={!isDraft || !canWrite}
              onChange={(e) => setHeader({ ...header, store_id: e.target.value })}>
              <option value="">{t('common.select')}</option>
              {myStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('intake.reason')}</label>
            <select className="form-input" value={header.reason} disabled={!isDraft || !canWrite}
              onChange={(e) => setHeader({ ...header, reason: e.target.value })}>
              {REASONS.map((r) => <option key={r} value={r}>{t(`intake.reason_${r}`)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.date')} *</label>
            <input type="date" className="form-input" value={header.intake_date} disabled={!isDraft || !canWrite}
              onChange={(e) => setHeader({ ...header, intake_date: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">{t('intake.believed_supplier')}</label>
            <SearchableSelect
              options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              value={header.supplier_id}
              onChange={(e) => setHeader({ ...header, supplier_id: e.target.value })}
              placeholder={t('intake.believed_supplier_hint')}
            />
            <div className="form-hint">{t('intake.believed_supplier_note')}</div>
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.notes')}</label>
            <input className="form-input" value={header.notes} disabled={!isDraft || !canWrite}
              onChange={(e) => setHeader({ ...header, notes: e.target.value })} />
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ add stock */}
      {isDraft && canWrite && (
        <div className="card intake-add" style={{ marginBottom: 'var(--spacing-lg)' }}>
          <h3>{t('intake.add_stock')}</h3>
          <div className="form-group">
            <label className="form-label">{t('common.product')}</label>
            <SearchableSelect
              options={productOptions}
              value={pickedProduct}
              onChange={(e) => { setPickedProduct(e.target.value); setGrid({}); }}
              placeholder={t('intake.pick_product')}
            />
          </div>

          {pickedProduct && !cat.loading && (
            <>
              <div className="intake-cost-row">
                <div className="form-group">
                  <label className="form-label">{t('intake.cost_per_pair')} *</label>
                  <input type="number" step="0.01" min="0" className="form-input"
                    value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
                </div>

                <div className="intake-cost-help">
                  {hint?.unit_cost != null ? (
                    <div className="intake-hint intake-hint--good">
                      {t('intake.hint_real', {
                        cost: hint.unit_cost,
                        source: hint.source === 'purchase' ? hint.source_label : t('intake.hint_catalogue'),
                      })}
                    </div>
                  ) : (
                    <div className="intake-hint">{t('intake.hint_none')}</div>
                  )}

                  <div className="intake-margin">
                    <span>{t('intake.fill_from_price')}</span>
                    <input type="number" className="form-input intake-margin-input"
                      value={margin} onChange={(e) => setMargin(e.target.value)} />
                    <span>%</span>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={fillFromMargin}>
                      {t('intake.fill')}
                    </button>
                    {hint?.default_selling_price != null && (
                      <span className="intake-hint">
                        {t('intake.sells_for', { price: money(hint.default_selling_price) })}
                      </span>
                    )}
                  </div>

                  <label className="intake-known">
                    <input type="checkbox" checked={known} onChange={(e) => setKnown(e.target.checked)} />
                    <span>{t('intake.i_know_this_cost')}</span>
                  </label>
                  <div className="form-hint">
                    {known ? t('intake.known_note') : t('intake.guess_note')}
                  </div>
                </div>
              </div>

              {/* Colour x size. One row and one column collapse away for a colourless
                  or sizeless category, so the same grid serves every product shape. */}
              <div className="table-container">
                <table className="table intake-grid">
                  <thead>
                    <tr>
                      <th>{cat.hasColors ? t('common.color') : ''}</th>
                      {sizeCols.map((s) => (
                        <th key={String(s.value)}>
                          {s.value
                            ? formatSize({ size_eu: s.value, size_label_en: s.label_en,
                                           size_label_ar: s.label_ar, size_prefix: cat.prefix,
                                           has_sizes: cat.hasSizes }, locale)
                            : t('intake.one_size')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {colorRows.map((c) => (
                      <tr key={String(c.id)}>
                        <td><strong>{c.color_name || t('intake.all')}</strong></td>
                        {sizeCols.map((s) => {
                          const key = `${c.id}|${s.value}`;
                          return (
                            <td key={key}>
                              <input type="number" min="0" className="form-input intake-cell"
                                value={grid[key] || ''}
                                onChange={(e) => setGrid({ ...grid, [key]: e.target.value })} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button type="button" className="btn btn-primary" onClick={addToSheet}>
                {t('intake.add_to_sheet')}
              </button>
            </>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------- lines */}
      <div className="card">
        <h3>{t('intake.lines')} ({lines.length})</h3>
        {lines.length === 0 ? (
          <p className="section-hint">{t('intake.no_lines')}</p>
        ) : (
          <div className="table-container">
            <table className="table" data-testid="intake-lines">
              <thead>
                <tr>
                  <th>{t('common.product')}</th>
                  <th>{t('common.color')}</th>
                  <th>{t('common.size')}</th>
                  <th>{t('common.quantity')}</th>
                  <th>{t('intake.cost_per_pair')}</th>
                  <th>{t('intake.cost_basis')}</th>
                  <th>{t('common.total')}</th>
                  {isDraft && canWrite && <th />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l._product}</td>
                    <td>{l._color || '—'}</td>
                    <td>{l._size}</td>
                    <td>{l.quantity}</td>
                    <td>{money(l.unit_cost)}</td>
                    <td>
                      <span className={`badge ${l.cost_is_estimated ? 'badge-warning' : 'badge-success'}`}>
                        {l.cost_is_estimated ? t('intake.guessed') : t('intake.known')}
                      </span>
                    </td>
                    <td>{money(l.quantity * l.unit_cost)}</td>
                    {isDraft && canWrite && (
                      <td>
                        <button className="btn btn-sm btn-danger"
                          onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                          {t('common.remove')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}><strong>{t('common.total')}</strong></td>
                  <td><strong>{totals.units}</strong></td>
                  <td />
                  <td>{totals.guessed > 0 && (
                    <span className="badge badge-warning">
                      {t('intake.n_guessed', { n: totals.guessed })}
                    </span>
                  )}</td>
                  <td><strong>{money(totals.value)}</strong></td>
                  {isDraft && canWrite && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {canWrite && (
          <div className="form-actions" style={{ marginTop: 'var(--spacing-lg)' }}>
            {isDraft && (
              <>
                <button className="btn btn-danger" onClick={remove}>{t('common.delete')}</button>
                <button className="btn btn-secondary" disabled={saving} onClick={() => save()}>
                  {t('intake.save_draft')}
                </button>
                <button className="btn btn-primary" disabled={saving || lines.length === 0}
                  onClick={() => save({ thenPost: true })}>
                  {t('intake.post')}
                </button>
              </>
            )}
            {intake.status === 'posted' && (
              <button className="btn btn-danger" onClick={reverse}>{t('intake.reverse')}</button>
            )}
          </div>
        )}
        {isDraft && (
          <p className="section-hint" style={{ marginTop: 'var(--spacing-sm)' }}>
            {t('intake.post_note')}
          </p>
        )}
      </div>
    </div>
  );
}
