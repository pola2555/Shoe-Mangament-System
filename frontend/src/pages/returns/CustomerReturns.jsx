import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import toast from 'react-hot-toast';
import { formatSize, formatColor } from '../../utils/variantFormat';
import { salesAPI, returnsAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import { HiOutlineMagnifyingGlass, HiOutlineArrowUturnLeft, HiOutlineQrCode } from 'react-icons/hi2';
import ClickableImage from '../../components/common/ClickableImage';
import useBarcodeScanner from '../../hooks/useBarcodeScanner';

const BarcodeScannerModal = lazy(() => import('../../components/barcode/BarcodeScannerModal'));

/**
 * What one line of a sale is actually worth back.
 *
 * NOT the price on the line. A sale-level discount belongs to the whole sale, so a
 * 1000 EGP cart with 100 off means each 500 EGP pair really cost 450. Refunding the
 * printed 500 hands back money that was never taken, and the server only notices when
 * the WHOLE sale is returned — a partial return sails straight through.
 *
 * The same pro-rata allocation the exchange screen and the server's own profit
 * calculation use, so all three agree.
 */
function netOf(item, sale) {
  const gross = Number(item.sale_price) || 0;
  const total = Number(sale?.total_amount) || 0;
  const disc = Number(sale?.discount_amount) || 0;
  if (!(total > 0) || !(disc > 0)) return Math.round(gross * 100) / 100;
  return Math.round((gross - (disc * gross) / total) * 100) / 100;
}

export default function CustomerReturns() {
  const { user } = useAuth();
  const { t, locale } = useTranslation();
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
  const [showScanner, setShowScanner] = useState(false);

  // A customer bringing something back is usually holding it, and it usually still has
  // its label. Scanning that is faster and more reliable than asking for a receipt.
  const saleRef = useRef(null);
  useEffect(() => { saleRef.current = selectedSale; }, [selectedSale]);

  const findByCode = useCallback(async (code) => {
    if (saleRef.current) return; // a sale is already open; nothing to look up
    setSearchQuery(code);
    try {
      setSearching(true);
      const res = await salesAPI.list({ search: code });
      const found = (res.data.data || [])
        .filter((x) => !x.voided_at)
        .filter((x) => parseFloat(x.refunded_amount || 0) < parseFloat(x.final_amount));
      setSearchResults(found);
      if (found.length === 1) loadSaleDetails(found[0].id);
      else if (found.length === 0) toast.error(t('returns.no_sales_found'));
    } catch {
      toast.error(t('returns.failed_search_sales'));
    } finally { setSearching(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useBarcodeScanner(findByCode, { enabled: !showScanner && !selectedSale });

  // Search Sales
  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    try {
      setSearching(true);
      const params = {};
      if (searchQuery.trim()) params.search = searchQuery;
      if (daysFilter) params.days = daysFilter;

      const res = await salesAPI.list(params);
      // The server scopes to the caller's branches already (utils/storeScope.js).
      // Filtering again here meant two places had to agree, and when they did not the
      // symptom was a sale that exists refusing to appear.
      let results = res.data.data;
      // A voided sale was undone in full; there is nothing left to give back.
      results = results.filter((s) => !s.voided_at);
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
            // Defaults to what the customer actually paid for this line, discount
            // included. Still editable — a damaged return might be refunded less.
            refund_amount: netOf(item, sale)
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
          <button type="button" className="btn btn-secondary" data-testid="returns-scan"
            onClick={() => setShowScanner(true)}>
            <HiOutlineQrCode /> {t('barcode.scan')}
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
                    <th>{t('sales.items')}</th>
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
                      {/* The sale can now be found by its product, so the row has to
                          say which products it holds — otherwise a product search
                          returns receipt numbers that explain nothing. */}
                      <td>
                        {s.item_count ? (
                          <>
                            <strong>{s.item_count}</strong>
                            {s.item_products?.length > 0 && (
                              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
                                {s.item_products.join(', ')}
                                {s.item_products_more > 0 ? ` +${s.item_products_more}` : ''}
                              </div>
                            )}
                          </>
                        ) : '—'}
                      </td>
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
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <ClickableImage src={item.image_url} thumbSrc={item.thumb_url}
                            alt={item.product_name} width={40} height={40}
                            style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }} />
                          <span>
                            {item.product_name}
                            <br />
                            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{item.sku}</span>
                          </span>
                        </span>
                      </td>
                      <td><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {!item.color_is_placeholder && item.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                        {formatColor(item) || '—'}</span></td>
                      <td>{formatSize(item, locale)}</td>
                      <td>
                        {parseFloat(item.sale_price).toLocaleString()} {t('common.currency')}
                        {/* When a sale carried a discount, the printed line price is
                            not what was taken for it. Saying so is the difference
                            between a refund and a small gift. */}
                        {netOf(item, selectedSale) < parseFloat(item.sale_price) - 0.01 && (
                          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                            {t('returns.actually_paid', { amount: netOf(item, selectedSale).toLocaleString() })}
                          </div>
                        )}
                      </td>
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

      {showScanner && (
        <Suspense fallback={null}>
          <BarcodeScannerModal
            onDetected={(code) => { setShowScanner(false); findByCode(code); }}
            onClose={() => setShowScanner(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
