import { useState } from 'react';
import toast from 'react-hot-toast';
import { salesAPI, returnsAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import { HiOutlineMagnifyingGlass, HiOutlineArrowUturnLeft } from 'react-icons/hi2';

export default function CustomerReturns() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [daysFilter, setDaysFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  
  const [selectedSale, setSelectedSale] = useState(null);
  const [loadingSale, setLoadingSale] = useState(false);
  
  // Return Form State
  const [selectedItems, setSelectedItems] = useState({}); // { sale_item_id: { selected: true, refund_amount: 150 } }
  const [refundMethod, setRefundMethod] = useState('cash');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  
  const [submitting, setSubmitting] = useState(false);

  // Search Sales
  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    try {
      setSearching(true);
      const params = {};
      if (searchQuery.trim()) params.search = searchQuery;
      if (daysFilter) params.days = daysFilter;

      const res = await salesAPI.list(params);
      let results = res.data.data;
      // Filter by assigned stores
      if (user?.role_name !== 'admin' && !user?.permissions?.all_stores && user?.assigned_stores?.length > 0) {
        results = results.filter(s => user.assigned_stores.includes(s.store_id));
      }
      // Exclude fully refunded sales
      results = results.filter(s => parseFloat(s.refunded_amount || 0) < parseFloat(s.final_amount));
      setSearchResults(results);
      if (results.length === 0) {
        toast.error(t('returns.no_sales_found'));
      } else if (results.length === 1) {
        loadSaleDetails(results[0].id);
      }
    } catch (err) {
      toast.error(t('returns.failed_search_sales'));
    } finally {
      setSearching(false);
    }
  };

  // Load Sale Details
  const loadSaleDetails = async (saleId) => {
    try {
      setLoadingSale(true);
      const res = await salesAPI.getById(saleId);
      const sale = res.data.data;
      setSelectedSale(sale);
      
      // Initialize items state mapping (exclude already returned items)
      const itemsMap = {};
      sale.items.forEach(item => {
        if (!item.is_returned) {
          itemsMap[item.id] = {
            selected: false,
            refund_amount: parseFloat(item.sale_price) || 0
          };
        }
      });
      setSelectedItems(itemsMap);
      
    } catch (err) {
      toast.error(t('returns.failed_load_sale'));
    } finally {
      setLoadingSale(false);
    }
  };

  // Toggle Item Selection
  const toggleItem = (itemId) => {
    setSelectedItems(prev => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        selected: !prev[itemId].selected
      }
    }));
  };

  // Change Refund Amount
  const updateRefundAmount = (itemId, val) => {
    setSelectedItems(prev => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        refund_amount: val
      }
    }));
  };

  // Process Return
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Filter out selected items
    const itemsToReturn = Object.entries(selectedItems)
      .filter(([_, state]) => state.selected)
      .map(([id, state]) => ({
        sale_item_id: id,
        refund_amount: parseFloat(state.refund_amount) || 0
      }));

    if (itemsToReturn.length === 0) {
      return toast.error(t('returns.select_at_least_one'));
    }

    try {
      setSubmitting(true);
      
      // We assume the items are returned to the store they were sold from
      // (Could optionally add a store selector here if returns go to a central warehouse)
      const payload = {
        sale_id: selectedSale.id,
        store_id: selectedSale.store_id, 
        reason,
        notes,
        refund_method: refundMethod,
        items: itemsToReturn
      };

      await returnsAPI.createCustomerReturn(payload);
      toast.success(t('returns.return_success'));
      
      // Reset
      setSelectedSale(null);
      setSearchQuery('');
      setSearchResults([]);
      setReason('');
      setNotes('');
      setRefundMethod('cash');
      
    } catch (err) {
      toast.error(err.response?.data?.message || t('returns.failed_process'));
    } finally {
      setSubmitting(false);
    }
  };

  const totalRefund = Object.values(selectedItems)
    .filter(s => s.selected)
    .reduce((sum, s) => sum + (parseFloat(s.refund_amount) || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
      
      {/* Search Bar */}
      <div className="card" style={{ padding: 'var(--spacing-lg)' }}>
        <h3 style={{ marginBottom: 'var(--spacing-md)' }}>{t('returns.lookup_sale')}</h3>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px', display: 'flex', alignItems: 'center', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-md)', padding: '0.5rem 1rem', minWidth: 0 }}>
            <HiOutlineMagnifyingGlass size={20} color="var(--color-text-muted)" style={{ marginRight: '0.5rem' }} />
            <input 
              type="text" 
              placeholder={t('returns.search_sale_placeholder')}
              style={{ background: 'transparent', border: 'none', color: 'var(--color-text)', width: '100%', outline: 'none', fontSize: '1rem' }}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-md)', padding: '0 0.5rem' }}>
             <select 
               style={{ background: 'transparent', border: 'none', outline: 'none', padding: '0.5rem', color: 'var(--color-text)', cursor: 'pointer' }}
               value={daysFilter}
               onChange={e => setDaysFilter(e.target.value)}
             >
               <option value="">{t('returns.all_time')}</option>
               <option value="1">{t('returns.last_24_hours')}</option>
               <option value="7">{t('returns.last_7_days')}</option>
               <option value="30">{t('returns.last_30_days')}</option>
             </select>
          </div>

          <button type="submit" className="btn btn-primary" disabled={searching}>
            {searching ? t('returns.searching') : t('common.search')}
          </button>
        </form>

        {/* Search Results (if multiple) */}
        {!selectedSale && searchResults.length > 1 && (
          <div style={{ marginTop: 'var(--spacing-md)' }}>
            <h4 style={{ marginBottom: 'var(--spacing-sm)', color: 'var(--color-text-secondary)' }}>{t('returns.multiple_matches')}</h4>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('sales.sale_number')}</th>
                    <th>{t('sales.customer')}</th>
                    <th>{t('sales.store')}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('common.total')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map(s => (
                    <tr key={s.id}>
                      <td><strong>{s.sale_number}</strong></td>
                      <td>{s.customer_name || t('pos.walk_in')} {s.customer_phone ? `(${s.customer_phone})` : ''}</td>
                      <td>{s.store_name}</td>
                      <td>{new Date(s.created_at).toLocaleDateString()}</td>
                      <td>{parseFloat(s.final_amount).toLocaleString()} {t('common.currency')}</td>
                      <td>
                        <button className="btn btn-sm btn-secondary" onClick={() => loadSaleDetails(s.id)}>{t('common.select')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Sale Details & Return Items */}
      {loadingSale && <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)' }}>{t('returns.loading_sale_details')}</div>}
      
      {selectedSale && !loadingSale && (
        <form className="card" onSubmit={handleSubmit} style={{ padding: 'var(--spacing-lg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-lg)', paddingBottom: 'var(--spacing-md)', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {t('returns.sale')}: {selectedSale.sale_number}
              </h3>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: '0.5rem' }}>
                {t('sales.store')}: <strong>{selectedSale.store_name}</strong> • 
                {t('sales.customer')}: <strong>{selectedSale.customer_name || t('pos.walk_in')}</strong> {selectedSale.customer_phone ? `(${selectedSale.customer_phone})` : ''} • 
                {t('common.date')}: {new Date(selectedSale.created_at).toLocaleString()}
              </div>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setSelectedSale(null)}>
              {t('returns.clear_selection')}
            </button>
          </div>

          <h4 style={{ marginBottom: 'var(--spacing-md)' }}>{t('returns.select_items_to_return')}</h4>
          <div className="table-container" style={{ marginBottom: 'var(--spacing-lg)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>{t('returns.return_col')}</th>
                  <th>{t('sales.product')}</th>
                  <th>{t('sales.color')}</th>
                  <th>{t('sales.size')}</th>
                  <th>{t('returns.sold_for')}</th>
                  <th style={{ width: 150 }}>{t('returns.refund_amount')} ({t('common.currency')})</th>
                </tr>
              </thead>
              <tbody>
                {selectedSale.items.filter(item => !item.is_returned).map(item => {
                  const state = selectedItems[item.id] || { selected: false, refund_amount: 0 };
                  return (
                    <tr key={item.id} style={{ background: state.selected ? 'rgba(var(--color-primary-rgb), 0.05)' : '' }}>
                      <td style={{ textAlign: 'center' }}>
                        <input 
                          type="checkbox" 
                          checked={state.selected}
                          onChange={() => toggleItem(item.id)}
                          style={{ width: 18, height: 18, cursor: 'pointer' }}
                        />
                      </td>
                      <td>{item.product_name} <br/> <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{item.sku}</span></td>
                      <td><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {item.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                        {item.color_name}</span></td>
                      <td>EU {item.size_eu}</td>
                      <td>{parseFloat(item.sale_price).toLocaleString()} {t('common.currency')}</td>
                      <td>
                        <input 
                          type="number"
                          className="form-input"
                          step="0.01"
                          min="0"
                          max={parseFloat(item.sale_price)} // Typically don't refund more than sold for
                          value={state.refund_amount}
                          onChange={e => updateRefundAmount(item.id, e.target.value)}
                          disabled={!state.selected}
                          style={{ padding: '0.3rem 0.5rem' }}
                        />
                      </td>
                    </tr>
                  )
                })}
                {selectedSale.items.filter(item => !item.is_returned).length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)' }}>
                    {t('returns.all_items_already_returned')}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginBottom: 'var(--spacing-md)' }}>{t('returns.return_details')}</h4>
          <div className="form-row" style={{ alignItems: 'flex-start' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('returns.refund_method')}</label>
              <select className="form-input" value={refundMethod} onChange={e => setRefundMethod(e.target.value)} required>
                <option value="cash">{t('pos.cash')}</option>
                <option value="card">{t('returns.card_refund')}</option>
                <option value="store_credit">{t('returns.store_credit')}</option>
                <option value="exchange">{t('returns.exchange')}</option>
                <option value="other">{t('common.other')}</option>
              </select>
            </div>
            
            <div className="form-group" style={{ flex: 2 }}>
              <label className="form-label">{t('returns.return_reason')}</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder={t('returns.reason_placeholder')}
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </div>
          </div>
          
          <div className="form-group">
            <label className="form-label">{t('returns.additional_notes')}</label>
            <textarea 
              className="form-input" 
              rows="2"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-xl)', paddingTop: 'var(--spacing-md)', borderTop: '2px dashed var(--color-border)', flexWrap: 'wrap', gap: 'var(--spacing-md)' }}>
            <div>
              <span style={{ fontSize: '1.1rem', color: 'var(--color-text-secondary)' }}>{t('returns.total_approved_refund')} </span>
              <span style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--color-danger)' }}>{totalRefund.toLocaleString()} {t('common.currency')}</span>
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.7rem 1.5rem', fontSize: '1rem' }} disabled={submitting}>
              <HiOutlineArrowUturnLeft style={{ marginRight: '0.5rem' }} />
              {submitting ? t('returns.processing') : t('returns.process_return')}
            </button>
          </div>
        </form>
      )}

    </div>
  );
}
