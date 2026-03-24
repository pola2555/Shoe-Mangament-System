import { useState, useEffect, useMemo } from 'react';
import { expensesAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';
import { useTranslation } from '../../i18n/i18nContext';

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [form, setForm] = useState({ store_id: '', category_id: '', amount: '', description: '', expense_date: new Date().toISOString().split('T')[0] });
  const [filters, setFilters] = useState({ store_id: '', category_id: '', dateFrom: '', dateTo: '', search: '' });
  const { hasPermission, filterStores } = useAuth();
  const canWrite = hasPermission('expenses', 'write');
  const { t } = useTranslation();

  useEffect(() => { fetchMeta(); fetchExpenses(); }, []);

  const fetchMeta = async () => {
    try {
      const [c, s] = await Promise.all([expensesAPI.getCategories(), storesAPI.list()]);
      setCategories(c.data.data);
      setStores(filterStores(s.data.data));
    } catch {}
  };

  const fetchExpenses = async () => {
    try { setLoading(true); const { data } = await expensesAPI.list(); setExpenses(data.data); }
    catch { toast.error('Failed'); }
    finally { setLoading(false); }
  };

  const filtered = useMemo(() => {
    let result = [...expenses];
    // Filter by assigned stores
    if (stores.length > 0) {
      const storeIds = stores.map(s => s.id);
      result = result.filter(e => !e.store_id || storeIds.includes(e.store_id));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(e => e.description.toLowerCase().includes(q) || (e.category_name && e.category_name.toLowerCase().includes(q)));
    }
    if (filters.store_id) result = result.filter(e => e.store_id === filters.store_id);
    if (filters.category_id) result = result.filter(e => String(e.category_id) === filters.category_id);
    if (filters.dateFrom) result = result.filter(e => e.expense_date >= filters.dateFrom);
    if (filters.dateTo) result = result.filter(e => e.expense_date <= filters.dateTo);
    return result;
  }, [expenses, filters]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await expensesAPI.create({ ...form, amount: parseFloat(form.amount), category_id: parseInt(form.category_id) });
      toast.success('Expense recorded');
      setShowForm(false);
      setForm({ store_id: '', category_id: '', amount: '', description: '', expense_date: new Date().toISOString().split('T')[0] });
      fetchExpenses();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  const handleDelete = async (id) => {
    if (!confirm(t('common.are_you_sure'))) return;
    try { await expensesAPI.delete(id); toast.success('Deleted'); fetchExpenses(); }
    catch { toast.error('Failed'); }
  };

  const total = filtered.reduce((s, e) => s + parseFloat(e.amount), 0);
  const activeFilterCount = [filters.store_id, filters.category_id, filters.dateFrom, filters.dateTo].filter(Boolean).length;

  // Category breakdown from filtered results
  const categoryBreakdown = useMemo(() => {
    const map = {};
    filtered.forEach(e => { map[e.category_name] = (map[e.category_name] || 0) + parseFloat(e.amount); });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('expenses.title')}</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
          <input className="form-input" placeholder={t('expenses.search_placeholder')} value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })} style={{ width: 200 }} />
          <button className={`btn ${showFilters || activeFilterCount ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => setShowFilters(!showFilters)}>
            🔍 {t('common.filters')}{activeFilterCount > 0 && ` (${activeFilterCount})`}
          </button>
          {canWrite && <button className="btn btn-primary" onClick={() => setShowForm(true)}>+ {t('expenses.add_expense')}</button>}
        </div>
      </div>

      {/* Advanced Filters */}
      {showFilters && (
        <div className="filters-panel card">
          <div className="filters-grid">
            <div className="form-group">
              <label className="form-label">{t('expenses.store')}</label>
              <SearchableSelect
                options={[
                  { value: '', label: t('stores.all_stores') },
                  ...stores.map((s) => ({ value: s.id, label: s.name }))
                ]}
                value={filters.store_id}
                onChange={(e) => setFilters({ ...filters, store_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('expenses.category')}</label>
              <SearchableSelect
                options={[
                  { value: '', label: t('common.all') },
                  ...categories.map((c) => ({ value: c.id, label: c.name }))
                ]}
                value={filters.category_id}
                onChange={(e) => setFilters({ ...filters, category_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.from')}</label>
              <input className="form-input" type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.to')}</label>
              <input className="form-input" type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-sm)', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
            <span className="filter-count">
              {filtered.length} {t('expenses.title').toLowerCase()} &nbsp;•&nbsp; {t('common.total')}: <strong style={{ color: 'var(--color-danger)' }}>{total.toLocaleString()} {t('common.currency')}</strong>
              {categoryBreakdown.length > 0 && <> &nbsp;•&nbsp; {categoryBreakdown.map(([cat, amt], i) => (
                <span key={cat} style={{ marginLeft: i > 0 ? 8 : 0 }}>{cat}: <strong>{amt.toLocaleString()}</strong></span>
              ))}</>}
            </span>
            {activeFilterCount > 0 && <button className="btn btn-sm btn-secondary"
              onClick={() => setFilters({ store_id: '', category_id: '', dateFrom: '', dateTo: '', search: '' })}>{t('common.clear')}</button>}
          </div>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{t('expenses.add_expense')}</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-row">
                <div className="form-group"><label className="form-label">{t('expenses.store')} *</label>
                  <SearchableSelect
                    required
                    options={[
                      { value: '', label: t('common.select') },
                      ...stores.map((s) => ({ value: s.id, label: s.name }))
                    ]}
                    value={form.store_id}
                    onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                  />
                </div>
                <div className="form-group"><label className="form-label">{t('expenses.category')} *</label>
                  <SearchableSelect
                    required
                    options={[
                      { value: '', label: t('common.select') },
                      ...categories.map((c) => ({ value: c.id, label: c.name }))
                    ]}
                    value={form.category_id}
                    onChange={(e) => setForm({ ...form, category_id: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">{t('expenses.amount')} ({t('common.currency')}) *</label>
                  <input className="form-input" type="number" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">{t('expenses.expense_date')} *</label>
                  <input className="form-input" type="date" required value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} /></div>
              </div>
              <div className="form-group"><label className="form-label">{t('expenses.description')} *</label>
                <input className="form-input" required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>{t('common.date')}</th><th>{t('expenses.store')}</th><th>{t('expenses.category')}</th><th>{t('expenses.description')}</th><th>{t('expenses.amount')}</th><th>By</th>{canWrite && <th></th>}</tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('expenses.no_expenses')}</td></tr>
              ) : filtered.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.expense_date).toLocaleDateString()}</td>
                  <td>{e.store_name}</td>
                  <td><span className="badge badge-neutral">{e.category_name}</span></td>
                  <td>{e.description}</td>
                  <td><strong>{parseFloat(e.amount).toLocaleString()} {t('common.currency')}</strong></td>
                  <td>{e.created_by_name}</td>
                  {canWrite && <td><button className="btn btn-sm btn-danger" onClick={() => handleDelete(e.id)}>✕</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
