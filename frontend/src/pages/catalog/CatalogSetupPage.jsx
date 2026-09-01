import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { productCategoriesAPI, sizeScalesAPI, colorPresetsAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import SearchableSelect from '../../components/common/SearchableSelect';
import { localizedName, sizeValueLabel, formatSize } from '../../utils/variantFormat';

/**
 * Categories, size lists and colours — everything that decides what a product can be.
 *
 * Nothing here can be deleted. A category is referenced by products and a size by
 * variants (and by labels already printed and stuck on boxes), so retiring one means
 * unticking Active. The screen says so where it matters rather than offering a delete
 * that would fail.
 */
export default function CatalogSetupPage() {
  const { t, locale } = useTranslation();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('product_categories', 'write');

  const [tab, setTab] = useState('categories');
  const [categories, setCategories] = useState([]);
  const [scales, setScales] = useState([]);
  const [colors, setColors] = useState([]);
  const [loading, setLoading] = useState(true);

  const [editingCat, setEditingCat] = useState(null);
  const [editingScale, setEditingScale] = useState(null);
  const [editingColor, setEditingColor] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      setLoading(true);
      const [c, s, p] = await Promise.all([
        productCategoriesAPI.list({ include_counts: 1 }),
        sizeScalesAPI.list({ include_values: 1 }),
        colorPresetsAPI.list(),
      ]);
      setCategories(c.data.data || []);
      setScales(s.data.data || []);
      setColors(p.data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || t('categories.load_failed'));
    } finally {
      setLoading(false);
    }
  }

  const scaleOptions = useMemo(
    () => scales.filter((s) => s.is_active).map((s) => ({ value: s.id, label: localizedName(s, locale) })),
    [scales, locale]
  );

  async function save(fn) {
    try {
      setSaving(true);
      await fn();
      toast.success(t('categories.saved'));
      await load();
      return true;
    } catch (err) {
      toast.error(err.response?.data?.message || t('categories.save_failed'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  // ================================================================ categories
  function blankCategory() {
    return {
      code: '', name_en: '', name_ar: '', has_colors: true, has_sizes: true,
      size_scale_id: scales.find((s) => s.code === 'eu_shoe')?.id || scales[0]?.id || '',
      sort_order: (categories.length + 1) * 10, is_active: true,
    };
  }

  async function saveCategory() {
    const c = editingCat;
    if (!c.name_en.trim() || !c.name_ar.trim()) return toast.error(t('categories.name_en'));
    // has_sizes = false always means the one-size list: every consumer then resolves a
    // scale the same way instead of branching on a flag.
    const oneSize = scales.find((s) => s.code === 'one_size');
    const payload = {
      name_en: c.name_en.trim(), name_ar: c.name_ar.trim(),
      has_colors: c.has_colors, has_sizes: c.has_sizes,
      size_scale_id: c.has_sizes ? c.size_scale_id : (oneSize?.id || c.size_scale_id),
      sort_order: Number(c.sort_order) || 0,
      is_active: c.is_active,
    };
    const ok = await save(() => (c.id
      ? productCategoriesAPI.update(c.id, payload)
      : productCategoriesAPI.create({ ...payload, code: c.code.trim() })));
    if (ok) setEditingCat(null);
  }

  // ================================================================ size lists
  function blankScale() {
    return {
      code: '', name_en: '', name_ar: '', display_prefix: '', display_suffix: '',
      is_numeric: false, is_active: true,
      values: [{ value: '', label_en: '', label_ar: '', sort_order: 10 }],
    };
  }

  async function saveScale() {
    const s = editingScale;
    const values = (s.values || [])
      .filter((v) => String(v.value).trim())
      .map((v, i) => ({
        value: String(v.value).trim(),
        label_en: v.label_en || null,
        label_ar: v.label_ar || null,
        sort_order: Number(v.sort_order ?? (i + 1) * 10),
        is_active: v.is_active !== false,
      }));
    if (!values.length) return toast.error(t('categories.add_value'));

    const meta = {
      name_en: s.name_en.trim(), name_ar: s.name_ar.trim(),
      display_prefix: s.display_prefix || '', display_suffix: s.display_suffix || '',
      is_numeric: !!s.is_numeric, is_active: s.is_active,
    };
    const ok = await save(async () => {
      if (s.id) {
        await sizeScalesAPI.update(s.id, meta);
        // Values are replaced as a whole set so a reorder is one atomic call, and the
        // server re-derives every affected variant's sort key from the new order.
        await sizeScalesAPI.replaceValues(s.id, values);
      } else {
        await sizeScalesAPI.create({ ...meta, code: s.code.trim(), values });
      }
    });
    if (ok) setEditingScale(null);
  }

  function setValue(i, field, v) {
    setEditingScale((s) => {
      const values = [...s.values];
      values[i] = { ...values[i], [field]: v };
      return { ...s, values };
    });
  }

  function moveValue(i, dir) {
    setEditingScale((s) => {
      const values = [...s.values];
      const j = i + dir;
      if (j < 0 || j >= values.length) return s;
      [values[i], values[j]] = [values[j], values[i]];
      // Renumber so the saved order is the order on screen.
      return { ...s, values: values.map((v, k) => ({ ...v, sort_order: (k + 1) * 10 })) };
    });
  }

  // ================================================================ colours
  async function saveColor() {
    const c = editingColor;
    if (!c.name_en.trim() || !c.name_ar.trim()) return toast.error(t('categories.name_en'));
    const payload = {
      name_en: c.name_en.trim(), name_ar: c.name_ar.trim(),
      hex_code: c.hex_code || null, sort_order: Number(c.sort_order) || 0,
      is_active: c.is_active !== false,
    };
    const ok = await save(() => (c.id ? colorPresetsAPI.update(c.id, payload) : colorPresetsAPI.create(payload)));
    if (ok) setEditingColor(null);
  }

  if (loading) return <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>{t('common.loading')}</div>;

  const TABS = [
    ['categories', t('categories.tab_categories')],
    ['scales', t('categories.tab_size_lists')],
    ['colors', t('categories.tab_colors')],
  ];

  return (
    <div>
      <div style={{ marginBottom: 'var(--spacing-lg)' }}>
        <h1 style={{ marginBottom: '.25rem' }}>{t('categories.title')}</h1>
        <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>{t('categories.subtitle')}</p>
      </div>

      <div style={{ display: 'flex', gap: '.4rem', marginBottom: 'var(--spacing-lg)', flexWrap: 'wrap' }}>
        {TABS.map(([key, label]) => (
          <button key={key} className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-secondary'}`}
            data-testid={`tab-${key}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {/* ---------------------------------------------------------- categories */}
      {tab === 'categories' && (
        <div className="card">
          {canWrite && (
            <button className="btn btn-primary btn-sm" style={{ marginBottom: 'var(--spacing-md)' }}
              data-testid="add-category" onClick={() => setEditingCat(blankCategory())}>
              + {t('categories.add_category')}
            </button>
          )}
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('categories.name_en')}</th>
                  <th>{t('categories.size_list')}</th>
                  <th>{t('products.colors')}</th>
                  <th>{t('common.status')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id} data-testid={`category-${c.code}`}>
                    <td>
                      <strong>{localizedName(c, locale)}</strong>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                        {c.code} · {t('categories.products_using', { count: c.product_count ?? 0 })}
                      </div>
                    </td>
                    <td>
                      {c.has_sizes
                        ? localizedName({ name_en: c.scale_name_en, name_ar: c.scale_name_ar }, locale)
                        : <span style={{ color: 'var(--color-text-secondary)' }}>{t('categories.hint_no_sizes')}</span>}
                    </td>
                    <td>{c.has_colors ? '✓' : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                    <td>
                      <span className={`badge ${c.is_active ? 'badge-success' : 'badge-danger'}`}>
                        {c.is_active ? t('categories.active') : t('categories.inactive')}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canWrite && (
                        <>
                          <button className="btn btn-sm btn-secondary" onClick={() => setEditingCat({ ...c })}>
                            {t('common.edit')}
                          </button>
                          <button className="btn btn-sm btn-secondary" style={{ marginInlineStart: 4 }}
                            onClick={() => save(() => productCategoriesAPI.toggleActive(c.id))}>
                            {c.is_active ? t('categories.inactive') : t('categories.active')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- size lists */}
      {tab === 'scales' && (
        <div className="card">
          {canWrite && (
            <button className="btn btn-primary btn-sm" style={{ marginBottom: 'var(--spacing-md)' }}
              data-testid="add-scale" onClick={() => setEditingScale(blankScale())}>
              + {t('categories.add_size_list')}
            </button>
          )}
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('categories.name_en')}</th>
                  <th>{t('categories.values')}</th>
                  <th>{t('categories.preview')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {scales.map((s) => (
                  <tr key={s.id} data-testid={`scale-${s.code}`}>
                    <td>
                      <strong>{localizedName(s, locale)}</strong>
                      {s.is_system && (
                        <span className="badge badge-neutral" style={{ marginInlineStart: 6 }}>
                          {t('categories.system_list')}
                        </span>
                      )}
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{s.code}</div>
                    </td>
                    <td style={{ maxWidth: 340 }}>
                      {(s.values || []).slice(0, 12).map((v) => sizeValueLabel(v, locale)).join(', ')}
                      {(s.values || []).length > 12 ? ` … (${s.values.length})` : ''}
                    </td>
                    <td style={{ fontFamily: 'monospace' }}>
                      {formatSize({
                        size_eu: (s.values || [])[0]?.value ?? '',
                        size_label: sizeValueLabel((s.values || [])[0], locale),
                        size_prefix: s.display_prefix,
                        size_suffix: s.display_suffix,
                      }) || '—'}
                    </td>
                    <td>
                      {canWrite && (
                        <button className="btn btn-sm btn-secondary"
                          onClick={() => setEditingScale({ ...s, values: (s.values || []).map((v) => ({ ...v })) })}>
                          {t('common.edit')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- colours */}
      {tab === 'colors' && (
        <div className="card">
          {canWrite && (
            <button className="btn btn-primary btn-sm" style={{ marginBottom: 'var(--spacing-md)' }}
              data-testid="add-color" onClick={() => setEditingColor({ name_en: '', name_ar: '', hex_code: '#000000', sort_order: (colors.length + 1) * 10, is_active: true })}>
              + {t('categories.add_color')}
            </button>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
            {colors.map((c) => (
              <button key={c.id} type="button" className="btn btn-secondary btn-sm"
                onClick={() => canWrite && setEditingColor({ ...c })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: c.is_active ? 1 : 0.5 }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: c.hex_code || '#ccc', border: '1px solid var(--color-border)' }} />
                {localizedName(c, locale)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- category editor */}
      {editingCat && (
        <div className="modal-overlay" onClick={() => setEditingCat(null)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>
              {editingCat.id ? t('categories.edit_category') : t('categories.add_category')}
            </h2>

            {!editingCat.id && (
              <div className="form-group">
                <label className="form-label">{t('categories.code')} *</label>
                <input className="form-input" value={editingCat.code} data-testid="cat-code"
                  onChange={(e) => setEditingCat({ ...editingCat, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                  placeholder="knives" />
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('categories.code_hint')}</small>
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('categories.name_en')} *</label>
                <input className="form-input" value={editingCat.name_en} data-testid="cat-name-en"
                  onChange={(e) => setEditingCat({ ...editingCat, name_en: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('categories.name_ar')} *</label>
                <input className="form-input" dir="rtl" value={editingCat.name_ar} data-testid="cat-name-ar"
                  onChange={(e) => setEditingCat({ ...editingCat, name_ar: e.target.value })} />
              </div>
            </div>

            <div className="form-group">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={editingCat.has_colors} data-testid="cat-has-colors"
                  onChange={(e) => setEditingCat({ ...editingCat, has_colors: e.target.checked })} />
                {t('categories.has_colors')}
              </label>
              {!editingCat.has_colors && (
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('categories.no_colors_note')}</small>
              )}
            </div>

            <div className="form-group">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={editingCat.has_sizes} data-testid="cat-has-sizes"
                  onChange={(e) => setEditingCat({ ...editingCat, has_sizes: e.target.checked })} />
                {t('categories.has_sizes')}
              </label>
              {!editingCat.has_sizes && (
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('categories.no_sizes_note')}</small>
              )}
            </div>

            {editingCat.has_sizes && (
              <div className="form-group">
                <label className="form-label">{t('categories.size_list')} *</label>
                <SearchableSelect
                  options={scaleOptions}
                  value={editingCat.size_scale_id}
                  onChange={(e) => setEditingCat({ ...editingCat, size_scale_id: e.target.value })}
                />
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('categories.size_list_hint')}</small>
              </div>
            )}

            {editingCat.id && (
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                {t('categories.shape_locked')}
              </p>
            )}

            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setEditingCat(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={saving} data-testid="cat-save" onClick={saveCategory}>
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- size list editor */}
      {editingScale && (
        <div className="modal-overlay" onClick={() => setEditingScale(null)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, maxHeight: '92vh', overflow: 'auto' }}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>
              {editingScale.id ? t('categories.edit_size_list') : t('categories.add_size_list')}
            </h2>

            {!editingScale.id && (
              <div className="form-group">
                <label className="form-label">{t('categories.code')} *</label>
                <input className="form-input" value={editingScale.code} data-testid="scale-code"
                  onChange={(e) => setEditingScale({ ...editingScale, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                  placeholder="blade_length" />
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('categories.name_en')} *</label>
                <input className="form-input" value={editingScale.name_en} data-testid="scale-name-en"
                  onChange={(e) => setEditingScale({ ...editingScale, name_en: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('categories.name_ar')} *</label>
                <input className="form-input" dir="rtl" value={editingScale.name_ar} data-testid="scale-name-ar"
                  onChange={(e) => setEditingScale({ ...editingScale, name_ar: e.target.value })} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('categories.prefix')}</label>
                <input className="form-input" value={editingScale.display_prefix || ''} placeholder="EU"
                  onChange={(e) => setEditingScale({ ...editingScale, display_prefix: e.target.value })} />
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('categories.prefix_hint')}</small>
              </div>
              <div className="form-group">
                <label className="form-label">{t('categories.suffix')}</label>
                <input className="form-input" value={editingScale.display_suffix || ''} placeholder="cm"
                  onChange={(e) => setEditingScale({ ...editingScale, display_suffix: e.target.value })} />
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('categories.suffix_hint')}</small>
              </div>
            </div>

            <div className="form-group">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!editingScale.is_numeric}
                  onChange={(e) => setEditingScale({ ...editingScale, is_numeric: e.target.checked })} />
                {t('categories.is_numeric')}
              </label>
              <small style={{ color: 'var(--color-text-secondary)' }}>{t('categories.is_numeric_hint')}</small>
            </div>

            <div style={{ margin: 'var(--spacing-md) 0 .4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{t('categories.values')}</strong>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>
                {t('categories.preview')}: {formatSize({
                  size_eu: (editingScale.values || [])[0]?.value || '42',
                  size_label: sizeValueLabel((editingScale.values || [])[0], locale),
                  size_prefix: editingScale.display_prefix,
                  size_suffix: editingScale.display_suffix,
                })}
              </span>
            </div>

            <div className="table-container" style={{ maxHeight: 320, overflow: 'auto' }}>
              <table className="table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>{t('categories.value')}</th>
                    <th>{t('categories.label_en')}</th>
                    <th>{t('categories.label_ar')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(editingScale.values || []).map((v, i) => (
                    <tr key={i}>
                      <td>
                        <input className="form-input" style={{ maxWidth: 90 }} value={v.value}
                          data-testid={`scale-value-${i}`}
                          onChange={(e) => setValue(i, 'value', e.target.value)} />
                        {v.variant_count > 0 && (
                          <div style={{ fontSize: '.75rem', color: 'var(--color-text-secondary)' }}
                            title={t('categories.in_use_cannot_remove')}>
                            {t('categories.variants_using', { count: v.variant_count })}
                          </div>
                        )}
                      </td>
                      <td><input className="form-input" value={v.label_en || ''} onChange={(e) => setValue(i, 'label_en', e.target.value)} /></td>
                      <td><input className="form-input" dir="rtl" value={v.label_ar || ''} onChange={(e) => setValue(i, 'label_ar', e.target.value)} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => moveValue(i, -1)} title="↑">↑</button>
                        <button type="button" className="btn btn-sm btn-secondary" style={{ marginInlineStart: 3 }} onClick={() => moveValue(i, 1)} title="↓">↓</button>
                        <button type="button" className="btn btn-sm btn-danger" style={{ marginInlineStart: 3 }}
                          disabled={v.variant_count > 0}
                          title={v.variant_count > 0 ? t('categories.in_use_cannot_remove') : t('common.delete')}
                          onClick={() => setEditingScale((s) => ({ ...s, values: s.values.filter((_, k) => k !== i) }))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '.5rem' }}
              data-testid="scale-add-value"
              onClick={() => setEditingScale((s) => ({
                ...s,
                values: [...(s.values || []), { value: '', label_en: '', label_ar: '', sort_order: ((s.values || []).length + 1) * 10 }],
              }))}>
              + {t('categories.add_value')}
            </button>

            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setEditingScale(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={saving} data-testid="scale-save" onClick={saveScale}>
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- colour editor */}
      {editingColor && (
        <div className="modal-overlay" onClick={() => setEditingColor(null)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>{t('categories.add_color')}</h2>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('categories.name_en')} *</label>
                <input className="form-input" value={editingColor.name_en} data-testid="color-name-en"
                  onChange={(e) => setEditingColor({ ...editingColor, name_en: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('categories.name_ar')} *</label>
                <input className="form-input" dir="rtl" value={editingColor.name_ar}
                  onChange={(e) => setEditingColor({ ...editingColor, name_ar: e.target.value })} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('products.hex_code')}</label>
              <input className="form-input" type="color" value={editingColor.hex_code || '#000000'}
                onChange={(e) => setEditingColor({ ...editingColor, hex_code: e.target.value })} />
            </div>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setEditingColor(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={saving} data-testid="color-save" onClick={saveColor}>
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
