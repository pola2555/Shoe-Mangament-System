import { useState, useEffect, useCallback, useRef } from 'react';
import { expensesAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import ExpenseCategoriesModal from './ExpenseCategoriesModal';
import ExpenseFormModal from './ExpenseFormModal';
import RecurringTab from './RecurringTab';
import BudgetsTab from './BudgetsTab';
import { categoryOptions, expenseCatPath, PAYMENT_METHODS, dateInput, money } from './expenseHelpers';
import '../products/Products.css';

const TABS = ['list', 'recurring', 'budgets'];

/**
 * Expenses.
 *
 * Everything here used to happen in the browser: the page called `GET /expenses` with
 * no parameters, the server answered with the newest 500 rows, and the filters and the
 * "Total" underneath them were computed over that. Past 500 expenses the totals
 * silently stopped being true — a money figure that quietly goes wrong is worse than
 * no figure. Filtering, counting and totalling are now all one SQL query, and the
 * figure under the table describes the whole filter rather than the page on screen.
 */
export default function ExpensesPage() {
  const { hasPermission, filterStores } = useAuth();
  const { t, locale } = useTranslation();
  const canWrite = hasPermission('expenses', 'write');
  const canSetup = hasPermission('expense_categories', 'write');

  const [tab, setTab] = useState('list');
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [grandTotal, setGrandTotal] = useState(0);
  const [categories, setCategories] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [editing, setEditing] = useState(null);
  const [dueCount, setDueCount] = useState(0);

  const [filters, setFilters] = useState({
    store_id: '', category_id: '', from_date: '', to_date: '', search: '', payment_method: '',
  });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);

  // Debounced, because it now costs a round-trip: typing "electricity" should not fire
  // eleven queries.
  const [searchInput, setSearchInput] = useState('');
  const searchTimer = useRef(null);
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
      setPage(1);
    }, 350);
    return () => clearTimeout(searchTimer.current);
  }, [searchInput]);

  const fetchMeta = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        expensesAPI.getCategories({ is_active: true }),
        storesAPI.list(),
      ]);
      setCategories(c.data.data || []);
      setStores(filterStores(s.data.data || []));
    } catch { /* the page still lists expenses without them */ }
    try {
      const { data } = await expensesAPI.listRecurring({ due_only: true });
      setDueCount((data.data || []).length);
    } catch { /* badge only */ }
  }, []);

  const fetchExpenses = useCallback(async () => {
    try {
      setLoading(true);
      const params = { page, limit };
      for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
      const { data } = await expensesAPI.list(params);
      setRows(data.data || []);
      setPagination(data.pagination);
      setGrandTotal(data.summary?.total || 0);
    } catch (err) {
      toast.error(err.response?.data?.message || t('expenses.no_expenses'));
    } finally { setLoading(false); }
  }, [filters, page, limit]);

  useEffect(() => { fetchMeta(); }, [fetchMeta]);
  useEffect(() => { if (tab === 'list') fetchExpenses(); }, [fetchExpenses, tab]);

  const setFilter = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };

  const handleDelete = async (id) => {
    if (!confirm(t('expenses.delete_confirm'))) return;
    try {
      await expensesAPI.delete(id);
      toast.success(t('common.deleted'));
      fetchExpenses();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const clearFilters = () => {
    setFilters({ store_id: '', category_id: '', from_date: '', to_date: '', search: '', payment_method: '' });
    setSearchInput('');
    setPage(1);
  };

  const activeFilterCount = [filters.store_id, filters.category_id, filters.from_date, filters.to_date, filters.payment_method].filter(Boolean).length;
  const currency = t('common.currency');
  const first = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const last = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('expenses.title')}</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
          {canSetup && (
            <button className="btn btn-secondary" data-testid="open-expense-categories"
              onClick={() => setShowCategories(true)}>{t('expenses.manage_categories')}</button>
          )}
          {canWrite && (
            <button className="btn btn-primary" data-testid="add-expense"
              onClick={() => setEditing({})}>+ {t('expenses.add_expense')}</button>
          )}
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 'var(--spacing-md)' }}>
        {TABS.map((key) => (
          <button key={key} className={`tab ${tab === key ? 'tab--active' : ''}`}
            data-testid={`expenses-tab-${key}`} onClick={() => setTab(key)}>
            {t(`expenses.${key === 'list' ? 'tab_list' : key}`)}
            {key === 'recurring' && dueCount > 0 && (
              <span className="badge badge-warning" style={{ marginInlineStart: 6 }}>{dueCount}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'recurring' && (
        <RecurringTab categories={categories} stores={stores} canWrite={canWrite} canSetup={canSetup}
          onPosted={() => { fetchMeta(); if (tab === 'list') fetchExpenses(); }} />
      )}

      {tab === 'budgets' && <BudgetsTab stores={stores} canSetup={canSetup} />}

      {tab === 'list' && (
        <>
          <div className="card filters-panel">
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
                <label className="form-label">{t('common.search')}</label>
                <input className="form-input" data-testid="expense-search"
                  placeholder={t('expenses.search_placeholder')}
                  value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
              </div>
              <button className={`btn ${showFilters || activeFilterCount ? 'btn-accent' : 'btn-secondary'}`}
                data-testid="toggle-expense-filters" onClick={() => setShowFilters(!showFilters)}>
                {t('common.filters')}{activeFilterCount > 0 && ` (${activeFilterCount})`}
              </button>
              {activeFilterCount > 0 && (
                <button className="btn btn-secondary" onClick={clearFilters}>{t('common.clear')}</button>
              )}
            </div>

            {showFilters && (
              <div className="filters-grid" style={{ marginTop: 'var(--spacing-md)' }}>
                <div className="form-group">
                  <label className="form-label">{t('common.store')}</label>
                  <SearchableSelect
                    options={[{ value: '', label: t('stores.all_stores') }, ...stores.map((s) => ({ value: s.id, label: s.name }))]}
                    value={filters.store_id} onChange={(e) => setFilter({ store_id: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('expenses.category')}</label>
                  <SearchableSelect
                    options={categoryOptions(categories, locale, { includeBlank: true, blankLabel: t('common.all') })}
                    value={filters.category_id} onChange={(e) => setFilter({ category_id: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('expenses.payment_method')}</label>
                  <SearchableSelect
                    options={[{ value: '', label: t('common.all') }, ...PAYMENT_METHODS.map((m) => ({ value: m, label: t(`payment_methods.${m}`) }))]}
                    value={filters.payment_method} onChange={(e) => setFilter({ payment_method: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.from')}</label>
                  <input className="form-input" type="date" data-testid="expense-from"
                    value={filters.from_date} onChange={(e) => setFilter({ from_date: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.to')}</label>
                  <input className="form-input" type="date" data-testid="expense-to"
                    value={filters.to_date} onChange={(e) => setFilter({ to_date: e.target.value })} />
                </div>
              </div>
            )}
          </div>

          {/* The figure describes every matching expense, not the rows on screen. */}
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 'var(--spacing-md)' }}>
            <span style={{ color: 'var(--color-text-secondary)' }} data-testid="expense-showing">
              {t('expenses.showing', { from: first, to: last, total: pagination.total })}
            </span>
            <span>
              {t('common.total')}:{' '}
              <strong style={{ color: 'var(--color-danger)', fontSize: '1.1em' }} data-testid="expense-total">
                {money(grandTotal, currency)}
              </strong>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '.8em', marginInlineStart: 8 }}>
                {t('expenses.page_total_note')}
              </span>
            </span>
          </div>

          {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
            <>
              <div className="table-container">
                <table className="table" data-testid="expenses-table">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('common.store')}</th>
                      <th>{t('expenses.category')}</th>
                      <th>{t('expenses.description')}</th>
                      <th>{t('expenses.paid_to')}</th>
                      <th>{t('expenses.payment_method')}</th>
                      <th style={{ textAlign: 'end' }}>{t('expenses.amount')}</th>
                      <th>{t('common.by')}</th>
                      {canWrite && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr><td colSpan={canWrite ? 9 : 8} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
                        {t('expenses.no_expenses')}
                      </td></tr>
                    ) : rows.map((e) => (
                      <tr key={e.id} data-testid={`expense-row-${e.id}`}>
                        <td>{dateInput(e.expense_date)}</td>
                        <td>{e.store_name}</td>
                        <td>
                          <span className={`badge ${e.category_id ? 'badge-neutral' : 'badge-warning'}`}>
                            {expenseCatPath(e, locale, t)}
                          </span>
                        </td>
                        <td>
                          {e.description || '—'}
                          {e.recurring_id && (
                            <span className="badge badge-neutral" style={{ marginInlineStart: 6 }}>
                              {t('expenses.recurring')}
                            </span>
                          )}
                          {e.receipt_count > 0 && (
                            <span className="badge badge-success" style={{ marginInlineStart: 6 }}>
                              {t('expenses.receipts')} {e.receipt_count}
                            </span>
                          )}
                        </td>
                        <td>{e.paid_to || '—'}</td>
                        <td>{e.payment_method ? t(`payment_methods.${e.payment_method}`) : '—'}</td>
                        <td style={{ textAlign: 'end' }}><strong>{money(e.amount, currency)}</strong></td>
                        <td>{e.created_by_name}</td>
                        {canWrite && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn btn-sm btn-secondary" data-testid={`edit-expense-${e.id}`}
                              onClick={() => setEditing(e)}>{t('common.edit')}</button>
                            <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }}
                              onClick={() => handleDelete(e.id)}>✕</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {pagination.totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 'var(--spacing-md)' }}>
                  <button className="btn btn-secondary btn-sm" disabled={pagination.page <= 1}
                    data-testid="expense-prev" onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    {t('expenses.prev')}
                  </button>
                  <span>{pagination.page} / {pagination.totalPages}</span>
                  <button className="btn btn-secondary btn-sm" disabled={pagination.page >= pagination.totalPages}
                    data-testid="expense-next" onClick={() => setPage((p) => p + 1)}>
                    {t('expenses.next')}
                  </button>
                  <select className="form-input" style={{ width: 90 }} value={limit}
                    onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
                    {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              )}
            </>
          )}
        </>
      )}

      {editing && (
        <ExpenseFormModal
          expense={editing.id ? editing : null}
          categories={categories}
          stores={stores}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchExpenses(); }}
        />
      )}

      {showCategories && (
        <ExpenseCategoriesModal
          canWrite={canSetup}
          onClose={() => setShowCategories(false)}
          onChanged={() => { fetchMeta(); fetchExpenses(); }}
        />
      )}
    </div>
  );
}
