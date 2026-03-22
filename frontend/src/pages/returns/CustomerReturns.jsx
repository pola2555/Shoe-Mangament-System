import { useState } from 'react';
import toast from 'react-hot-toast';
import { salesAPI, returnsAPI, storesAPI } from '../../api';
import { HiOutlineMagnifyingGlass, HiOutlineArrowUturnLeft } from 'react-icons/hi2';

export default function CustomerReturns() {
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
      setSearchResults(res.data.data);
      if (res.data.data.length === 0) {
        toast.error('No sales found matching that query.');
      } else if (res.data.data.length === 1) {
        loadSaleDetails(res.data.data[0].id);
      }
    } catch (err) {
      toast.error('Failed to search sales');
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
      
      // Initialize items state mapping
      const itemsMap = {};
      sale.items.forEach(item => {
        itemsMap[item.id] = {
          selected: false,
          refund_amount: parseFloat(item.sale_price) || 0
        };
      });
      setSelectedItems(itemsMap);
      
    } catch (err) {
      toast.error('Failed to load sale details');
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
      return toast.error('Please select at least one item to return');
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
      toast.success('Return processed successfully!');
      
      // Reset
      setSelectedSale(null);
      setSearchQuery('');
      setSearchResults([]);
      setReason('');
      setNotes('');
      setRefundMethod('cash');
      
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to process return');
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
        <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Lookup Sale</h3>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-md)', padding: '0.5rem 1rem' }}>
            <HiOutlineMagnifyingGlass size={20} color="var(--color-text-muted)" style={{ marginRight: '0.5rem' }} />
            <input 
              type="text" 
              placeholder="Sale Number (S-...), Customer Phone, or Name"
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
               <option value="">All Time</option>
               <option value="1">Last 24 Hours</option>
               <option value="7">Last 7 Days</option>
               <option value="30">Last 30 Days</option>
             </select>
          </div>

          <button type="submit" className="btn btn-primary" disabled={searching}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </form>

        {/* Search Results (if multiple) */}
        {!selectedSale && searchResults.length > 1 && (
          <div style={{ marginTop: 'var(--spacing-md)' }}>
            <h4 style={{ marginBottom: 'var(--spacing-sm)', color: 'var(--color-text-secondary)' }}>Multiple matches found:</h4>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Sale No.</th>
                    <th>Customer</th>
                    <th>Store</th>
                    <th>Date</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map(s => (
                    <tr key={s.id}>
                      <td><strong>{s.sale_number}</strong></td>
                      <td>{s.customer_name || 'Walk-in'} {s.customer_phone ? `(${s.customer_phone})` : ''}</td>
                      <td>{s.store_name}</td>
                      <td>{new Date(s.created_at).toLocaleDateString()}</td>
                      <td>{parseFloat(s.final_amount).toLocaleString()} EGP</td>
                      <td>
                        <button className="btn btn-sm btn-secondary" onClick={() => loadSaleDetails(s.id)}>Select</button>
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
      {loadingSale && <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)' }}>Loading sale details...</div>}
      
      {selectedSale && !loadingSale && (
        <form className="card" onSubmit={handleSubmit} style={{ padding: 'var(--spacing-lg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-lg)', paddingBottom: 'var(--spacing-md)', borderBottom: '1px solid var(--color-border)' }}>
            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Sale: {selectedSale.sale_number}
              </h3>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: '0.5rem' }}>
                Store: <strong>{selectedSale.store_name}</strong> • 
                Customer: <strong>{selectedSale.customer_name || 'Walk-in'}</strong> {selectedSale.customer_phone ? `(${selectedSale.customer_phone})` : ''} • 
                Date: {new Date(selectedSale.created_at).toLocaleString()}
              </div>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setSelectedSale(null)}>
              Clear Selection
            </button>
          </div>

          <h4 style={{ marginBottom: 'var(--spacing-md)' }}>Select Items to Return</h4>
          <div className="table-container" style={{ marginBottom: 'var(--spacing-lg)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>Return</th>
                  <th>Product</th>
                  <th>Color</th>
                  <th>Size</th>
                  <th>Sold For</th>
                  <th style={{ width: 150 }}>Refund Amount (EGP)</th>
                </tr>
              </thead>
              <tbody>
                {selectedSale.items.map(item => {
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
                      <td>{parseFloat(item.sale_price).toLocaleString()} EGP</td>
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
              </tbody>
            </table>
          </div>

          <h4 style={{ marginBottom: 'var(--spacing-md)' }}>Return Details</h4>
          <div className="form-row" style={{ alignItems: 'flex-start' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Refund Method</label>
              <select className="form-input" value={refundMethod} onChange={e => setRefundMethod(e.target.value)} required>
                <option value="cash">Cash</option>
                <option value="card">Card Refund</option>
                <option value="store_credit">Store Credit (Wallet)</option>
                <option value="exchange">Exchange (No payout)</option>
                <option value="other">Other</option>
              </select>
            </div>
            
            <div className="form-group" style={{ flex: 2 }}>
              <label className="form-label">Return Reason</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="e.g. Defective, Size doesn't fit..."
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </div>
          </div>
          
          <div className="form-group">
            <label className="form-label">Additional Notes</label>
            <textarea 
              className="form-input" 
              rows="2"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-xl)', paddingTop: 'var(--spacing-md)', borderTop: '2px dashed var(--color-border)' }}>
            <div>
              <span style={{ fontSize: '1.2rem', color: 'var(--color-text-secondary)' }}>Total Approved Refund: </span>
              <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-danger)' }}>{totalRefund.toLocaleString()} EGP</span>
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.8rem 2rem', fontSize: '1.1rem' }} disabled={submitting}>
              <HiOutlineArrowUturnLeft style={{ marginRight: '0.5rem' }} />
              {submitting ? 'Processing...' : 'Process Return'}
            </button>
          </div>
        </form>
      )}

    </div>
  );
}
