import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { suppliersAPI, inventoryAPI, returnsAPI } from '../../api';
import SearchableSelect from '../../components/common/SearchableSelect';
import { HiOutlineMagnifyingGlass, HiOutlineArrowUturnLeft } from 'react-icons/hi2';

export default function SupplierReturns() {
  const [suppliers, setSuppliers] = useState([]);
  const [selectedSupplier, setSelectedSupplier] = useState('');
  
  const [inventory, setInventory] = useState([]);
  const [loadingInventory, setLoadingInventory] = useState(false);
  
  const [selectedItemIds, setSelectedItemIds] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchSuppliers();
  }, []);

  useEffect(() => {
    if (selectedSupplier) {
      fetchSupplierInventory(selectedSupplier);
    } else {
      setInventory([]);
      setSelectedItemIds(new Set());
    }
  }, [selectedSupplier]);

  const fetchSuppliers = async () => {
    try {
      const res = await suppliersAPI.list();
      setSuppliers(res.data.data);
    } catch (err) {
      toast.error('Failed to load suppliers');
    }
  };

  const fetchSupplierInventory = async (supplierId) => {
    try {
      setLoadingInventory(true);
      // Fetch only items currently in stock that came from this supplier
      const res = await inventoryAPI.list({ 
        supplier_id: supplierId,
        status: 'in_stock',
        source: 'purchase',
        limit: 1000
      });
      setInventory(res.data.data);
      setSelectedItemIds(new Set());
    } catch (err) {
      toast.error('Failed to load supplier inventory');
    } finally {
      setLoadingInventory(false);
    }
  };

  const toggleItem = (id) => {
    const newSet = new Set(selectedItemIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedItemIds(newSet);
  };

  const toggleAllFiltered = () => {
    if (filteredInventory.length === 0) return;
    const allSelected = filteredInventory.every(item => selectedItemIds.has(item.id));
    
    const newSet = new Set(selectedItemIds);
    if (allSelected) {
      // Unselect all filtered
      filteredInventory.forEach(item => newSet.delete(item.id));
    } else {
      // Select all filtered
      filteredInventory.forEach(item => newSet.add(item.id));
    }
    setSelectedItemIds(newSet);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (selectedItemIds.size === 0) return toast.error('Please select at least one item to return');
    
    try {
      setSubmitting(true);
      const payload = {
        supplier_id: selectedSupplier,
        reason,
        notes,
        items: Array.from(selectedItemIds)
      };

      await returnsAPI.createSupplierReturn(payload);
      toast.success('Supplier return processed successfully');
      
      // Reset
      setReason('');
      setNotes('');
      setSearchQuery('');
      // Refresh inventory grid
      fetchSupplierInventory(selectedSupplier);
      
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to process supplier return');
    } finally {
      setSubmitting(false);
    }
  };

  // Filter the grid on the client side
  const q = searchQuery.toLowerCase();
  const filteredInventory = inventory.filter(item => 
    !q || 
    (item.product_name && item.product_name.toLowerCase().includes(q)) ||
    (item.sku && item.sku.toLowerCase().includes(q)) ||
    (item.color_name && item.color_name.toLowerCase().includes(q))
  );

  const totalCost = Array.from(selectedItemIds).reduce((sum, id) => {
    const item = inventory.find(i => i.id === id);
    return sum + (item ? parseFloat(item.cost || 0) : 0);
  }, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
      
      {/* Supplier Selection */}
      <div className="card" style={{ padding: 'var(--spacing-lg)' }}>
        <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Select Supplier</h3>
        <div style={{ maxWidth: 400 }}>
          <SearchableSelect
            options={suppliers.map(s => ({ value: s.id, label: s.name }))}
            value={selectedSupplier}
            onChange={(e) => setSelectedSupplier(e.target.value)}
            placeholder="Search Supplier..."
          />
        </div>
      </div>

      {loadingInventory && <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)' }}>Loading inventory...</div>}

      {/* Inventory & Return Form */}
      {selectedSupplier && !loadingInventory && (
        <form className="card" onSubmit={handleSubmit} style={{ padding: 'var(--spacing-lg)' }}>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
            <h4 style={{ margin: 0 }}>Select Items to Return from {suppliers.find(s => s.id === selectedSupplier)?.name}</h4>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-md)', padding: '0.3rem 0.8rem', width: 300 }}>
              <HiOutlineMagnifyingGlass color="var(--color-text-muted)" style={{ marginRight: '0.5rem' }} />
              <input 
                type="text" 
                placeholder="Filter by product, SKU, or color..."
                style={{ background: 'transparent', border: 'none', color: 'var(--color-text)', width: '100%', outline: 'none', fontSize: '0.9rem' }}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="table-container" style={{ maxHeight: 400, overflow: 'auto', marginBottom: 'var(--spacing-lg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
            {inventory.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--spacing-2xl)', color: 'var(--color-text-muted)' }}>
                No active inventory found from this supplier.
              </div>
            ) : filteredInventory.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--spacing-md)', color: 'var(--color-text-muted)' }}>
                No items match your filter.
              </div>
            ) : (
              <table className="table" style={{ margin: 0 }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--color-bg-base)', zIndex: 1, boxShadow: '0 1px 2px rgba(0,0,0,0.1)' }}>
                  <tr>
                    <th style={{ width: 40, textAlign: 'center' }}>
                      <input 
                        type="checkbox" 
                        onChange={toggleAllFiltered} 
                        checked={filteredInventory.length > 0 && filteredInventory.every(i => selectedItemIds.has(i.id))}
                        style={{ width: 16, height: 16, cursor: 'pointer' }}
                      />
                    </th>
                    <th>Product</th>
                    <th>Color</th>
                    <th>Size</th>
                    <th>Cost (Unit Price)</th>
                    <th>Received At</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInventory.map(item => (
                    <tr key={item.id} style={{ background: selectedItemIds.has(item.id) ? 'rgba(var(--color-primary-rgb), 0.05)' : '' }}>
                      <td style={{ textAlign: 'center' }}>
                        <input 
                          type="checkbox" 
                          checked={selectedItemIds.has(item.id)}
                          onChange={() => toggleItem(item.id)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                      </td>
                      <td>{item.product_name} <br/> <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{item.sku}</span></td>
                      <td><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {item.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                        {item.color_name}</span></td>
                      <td>EU {item.size_eu}</td>
                      <td>{parseFloat(item.cost).toLocaleString()} EGP</td>
                      <td>{new Date(item.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h4 style={{ marginBottom: 'var(--spacing-md)' }}>Return Details</h4>
          <div className="form-group">
            <label className="form-label">Return Reason</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="e.g. Defective, Wrong Size, Poor Quality..."
              value={reason}
              onChange={e => setReason(e.target.value)}
              required
            />
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
              <span style={{ fontSize: '1.2rem', color: 'var(--color-text-secondary)' }}>Items Selected: </span>
              <span style={{ fontSize: '1.2rem', fontWeight: 600, marginRight: '1rem' }}>{selectedItemIds.size}</span>
              <span style={{ fontSize: '1.2rem', color: 'var(--color-text-secondary)' }}>Supplier Credit Estimate: </span>
              <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-success)' }}>{totalCost.toLocaleString()} EGP</span>
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.8rem 2rem', fontSize: '1.1rem' }} disabled={submitting || selectedItemIds.size === 0}>
              <HiOutlineArrowUturnLeft style={{ marginRight: '0.5rem' }} />
              {submitting ? 'Processing...' : 'Return to Supplier'}
            </button>
          </div>

        </form>
      )}

    </div>
  );
}
