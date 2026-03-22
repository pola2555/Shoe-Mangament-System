import { useState, useEffect } from 'react';
import { inventoryAPI, customersAPI, storesAPI, salesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import {
  HiOutlineShoppingBag,
  HiOutlineUser,
  HiOutlineBuildingStorefront,
  HiOutlineTrash,
  HiOutlineMagnifyingGlass,
  HiOutlineUserPlus
} from 'react-icons/hi2';
import CheckoutModal from './CheckoutModal';
import ProductSelectorModal from './ProductSelectorModal';

export default function POSPage() {
  const { user } = useAuth();
  
  // Data
  const [stores, setStores] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  
  // State
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Selection
  const [selectedStore, setSelectedStore] = useState(() => localStorage.getItem('pos_store') || '');
  const [selectedCustomer, setSelectedCustomer] = useState(() => localStorage.getItem('pos_customer') || ''); // Empty = Walk-in
  const [cart, setCart] = useState(() => {
    const saved = localStorage.getItem('pos_cart');
    return saved ? JSON.parse(saved) : [];
  });

  // Quick Add Customer
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', notes: '' });
  const [addingCustomer, setAddingCustomer] = useState(false);

  // Modals & Process
  const [showCheckout, setShowCheckout] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  
  // Product Selection Modal
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Initialize
  useEffect(() => {
    fetchInitialData();
  }, []);

  // Persist State
  useEffect(() => {
    localStorage.setItem('pos_store', selectedStore);
    localStorage.setItem('pos_customer', selectedCustomer);
    localStorage.setItem('pos_cart', JSON.stringify(cart));
  }, [selectedStore, selectedCustomer, cart]);

  // Fetch products when store changes or search query changes
  useEffect(() => {
    if (selectedStore) {
      handleSearch();
    } else {
      setProducts([]);
    }
  }, [selectedStore]);

  const fetchInitialData = async () => {
    try {
      setLoading(true);
      const [strs, custs] = await Promise.all([
        storesAPI.list(),
        customersAPI.list()
      ]);
      setStores(strs.data.data);
      setCustomers(custs.data.data);
      
      // Only auto-select store if we don't already have one from localStorage
      if (strs.data.data.length > 0 && !selectedStore) {
        setSelectedStore(strs.data.data[0].id);
      }
    } catch (err) {
      toast.error('Failed to load POS data');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    if (!selectedStore) return;

    try {
      setSearching(true);
      // We need sellable inventory items summarized by product (status is automatically in_stock in summary)
      const res = await inventoryAPI.summary({
        store_id: selectedStore,
        search: searchQuery,
        limit: 50
      });
      
      // Group by product_id so we show exactly one card per product model
      const productMap = new Map();
      res.data.data.forEach(item => {
        if (!productMap.has(item.product_id)) {
          productMap.set(item.product_id, {
            ...item,
            quantity: Number(item.quantity)
          });
        } else {
          productMap.get(item.product_id).quantity += Number(item.quantity);
        }
      });
      
      setProducts(Array.from(productMap.values()));
    } catch (err) {
      toast.error('Search failed');
    } finally {
      setSearching(false);
    }
  };

  const addToCart = (physicalItem) => {
    const maxPrice = parseFloat(physicalItem.max_selling_price || 999999);
    const minPrice = parseFloat(physicalItem.min_selling_price || 0);
    let defaultPrice = parseFloat(physicalItem.store_selling_price || physicalItem.default_selling_price || 0);

    if (defaultPrice > maxPrice) defaultPrice = maxPrice;
    if (defaultPrice < minPrice) defaultPrice = minPrice;

    setCart([...cart, { ...physicalItem, sale_price: defaultPrice }]);
    toast.success(`Added ${physicalItem.product_name} Size ${physicalItem.size_eu}`);
    // Optional: close modal immediately or let the cashier keep tapping sizes
  };

  const updateCartItemPrice = (index, value) => {
    const updated = [...cart];
    updated[index].sale_price = value; // Keep as string or number from input
    setCart(updated);
  };

  const removeFromCart = (index) => {
    setCart(cart.filter((_, i) => i !== index));
    // If it matches the current search/store, put it back in the list
    setTimeout(() => handleSearch(), 100);
  };

  const handleCheckout = async (paymentDetails) => {
    if (!selectedStore || cart.length === 0) return;
    try {
      setCheckingOut(true);
      
      const payload = {
        store_id: selectedStore,
        customer_id: selectedCustomer || null,
        items: cart.map(item => ({ id: item.id, sale_price: parseFloat(item.sale_price) || 0 })),
        discount_amount: 0,
        notes: '',
        payments: [{
          amount: total,
          payment_method: paymentDetails.method,
          reference_no: paymentDetails.reference || ''
        }]
      };

      await salesAPI.create(payload);
      toast.success('Sale completed successfully!');
      
      // Reset POS
      setCart([]);
      setSearchQuery('');
      // Keep store and customer as they were, or clear customer if you prefer
      // For a quick workflow, usually customer clears for the next person
      setSelectedCustomer('');
      setShowCheckout(false);
      
      // Refresh available inventory list
      handleSearch();
      
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to complete sale');
    } finally {
      setCheckingOut(false);
    }
  };

  const total = cart.reduce((sum, item) => sum + (parseFloat(item.sale_price) || 0), 0);

  const isValidPrice = (item) => {
    const price = parseFloat(item.sale_price);
    if (isNaN(price)) return false;
    const min = parseFloat(item.min_selling_price || 0);
    const max = parseFloat(item.max_selling_price || 999999);
    return price >= min && price <= max;
  };
  
  const isCartValid = cart.length > 0 && cart.every(isValidPrice);

  const handleQuickAddCustomer = async (e) => {
    e.preventDefault();
    if (!newCustomer.phone) return toast.error('Phone number is required');
    try {
      setAddingCustomer(true);
      const res = await customersAPI.create(newCustomer);
      const created = res.data.data;
      setCustomers([...customers, created]);
      setSelectedCustomer(created.id);
      setShowAddCustomer(false);
      setNewCustomer({ name: '', phone: '', notes: '' });
      toast.success('Customer added successfully!');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to add customer');
    } finally {
      setAddingCustomer(false);
    }
  };

  // -- Render Helpers --
  
  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 120px)', gap: 'var(--spacing-lg)', margin: '-var(--spacing-lg) 0' }}>
      
      {/* LEFT: Product Selection */}
      <div className="card" style={{ flex: 2, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-md)', padding: '0.5rem 1rem' }}>
              <HiOutlineMagnifyingGlass size={20} color="var(--color-text-muted)" style={{ marginRight: '0.5rem' }} />
              <form onSubmit={handleSearch} style={{ width: '100%' }}>
                <input 
                  type="text" 
                  placeholder="Scan barcode or search by name, model, SKU..." 
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-text)', width: '100%', outline: 'none', fontSize: '1rem' }}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                />
              </form>
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleSearch} disabled={searching || !selectedStore}>
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!selectedStore ? (
            <div style={{ textAlign: 'center', padding: 'var(--spacing-2xl)', color: 'var(--color-text-muted)' }}>
              Please select a store to view inventory.
            </div>
          ) : products.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 'var(--spacing-2xl)', color: 'var(--color-text-muted)' }}>
              {searching ? 'Loading...' : 'No available items found. Try a different search.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--spacing-md)' }}>
              {products.map(item => (
                <div 
                  key={item.product_id} 
                  className="card" 
                  style={{ padding: 'var(--spacing-sm)', cursor: 'pointer', transition: 'all 0.2s', border: '1px solid var(--color-border)', '&:hover': { borderColor: 'var(--color-primary)' }, display: 'flex', flexDirection: 'column' }}
                  onClick={() => setSelectedProduct(item)}
                >
                  <div style={{ width: '100%', height: 140, backgroundColor: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', marginBottom: 'var(--spacing-sm)' }}>
                    {item.product_image ? (
                      <img src={item.product_image} alt={item.product_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>No Image</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.2rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '1rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.product_name}
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{item.brand}</span>
                    <span>{item.product_code}</span>
                  </div>
                  
                  <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, color: 'var(--color-success)', fontSize: '1.1rem' }}>
                      {parseFloat(item.store_selling_price || item.default_selling_price || 0).toLocaleString()} <span style={{fontSize:'0.7em'}}>EGP</span>
                    </span>
                    <span className="badge badge-primary">{item.quantity} in stock</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT: Cart & Checkout */}
      <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '3px solid var(--color-primary)', backgroundColor: 'var(--color-bg-secondary)' }}>
        <h3 style={{ marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <HiOutlineShoppingBag /> Current Sale
        </h3>

        {/* Store & Customer Selectors */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><HiOutlineBuildingStorefront /> Location</label>
            <SearchableSelect
              options={stores.map(s => ({ value: s.id, label: s.name }))}
              value={selectedStore}
              onChange={(e) => setSelectedStore(e.target.value)}
              placeholder="Select Store..."
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.3rem' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><HiOutlineUser /> Customer</span>
              <button 
                type="button" 
                className="btn btn-sm btn-ghost" 
                style={{ padding: '0 0.5rem', height: 'auto', fontSize: '0.8rem', color: 'var(--color-primary)' }}
                onClick={() => setShowAddCustomer(true)}
              >
                + Quick Add
              </button>
            </label>
            <SearchableSelect
              options={[
                { value: '', label: '— Walk-in Customer —' },
                ...customers.map(c => ({ value: c.id, label: `${c.name || 'Unnamed'} (${c.phone})` }))
              ]}
              value={selectedCustomer}
              onChange={(e) => setSelectedCustomer(e.target.value)}
            />
          </div>
        </div>

        {/* Cart Items */}
        <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)', padding: 'var(--spacing-sm) 0', marginBottom: 'var(--spacing-md)' }}>
          {cart.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', marginTop: 'var(--spacing-2xl)' }}>
              Cart is empty
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
              {cart.map((item, index) => {
                const isValid = isValidPrice(item);
                const minP = parseFloat(item.min_selling_price || 0);
                const maxP = parseFloat(item.max_selling_price || 999999);
                return (
                  <div key={`${item.id}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', background: 'var(--color-bg-base)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ flex: 1, marginRight: 'var(--spacing-sm)' }}>
                      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)' }}>{item.product_name || item.sku}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                        Size {item.size_eu} • {item.color_name || 'N/A'}
                      </div>
                      {!isValid && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--color-danger)', marginTop: 2 }}>
                          Price must be between {minP} and {maxP < 999999 ? maxP : '∞'} EGP
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input
                        type="number"
                        className="form-input"
                        style={{ width: 80, padding: '0.2rem 0.5rem', textAlign: 'right', borderColor: isValid ? undefined : 'var(--color-danger)', background: isValid ? undefined : 'rgba(var(--color-danger-rgb), 0.1)' }}
                        value={item.sale_price}
                        onChange={e => updateCartItemPrice(index, e.target.value)}
                        step="0.01"
                      />
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginRight: '0.5rem' }}>EGP</span>
                      <button className="btn btn-sm btn-danger" style={{ padding: '0.3rem' }} onClick={() => removeFromCart(index)}>
                        <HiOutlineTrash size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Totals */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: 'var(--spacing-lg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-text-secondary)' }}>
            <span>Total Items</span>
            <span>{cart.length} items</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.25rem', fontWeight: 700, marginTop: '0.5rem', borderTop: '1px dashed var(--color-border)', paddingTop: '0.5rem' }}>
            <span>Total Due</span>
            <span style={{ color: 'var(--color-success)' }}>{total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP</span>
          </div>
        </div>

        <button 
          className="btn btn-primary" 
          style={{ width: '100%', padding: '1rem', fontSize: '1.1rem' }}
          disabled={!isCartValid}
          onClick={() => setShowCheckout(true)}
        >
          Proceed to Pay — {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP
        </button>
      </div>

      {showCheckout && (
        <CheckoutModal
          total={total}
          onClose={() => setShowCheckout(false)}
          onConfirm={handleCheckout}
        />
      )}

      {selectedProduct && (
        <ProductSelectorModal
          product={selectedProduct}
          storeId={selectedStore}
          cartItemIds={new Set(cart.map(c => c.id))}
          onClose={() => setSelectedProduct(null)}
          onAddToCart={addToCart}
        />
      )}

      {/* Quick Add Customer Modal */}
      {showAddCustomer && (
        <div className="modal-overlay" onClick={() => setShowAddCustomer(false)}>
          <div className="modal-content card" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>Quick Add Customer</h2>
            <form onSubmit={handleQuickAddCustomer}>
              <div className="form-group">
                <label className="form-label">Name</label>
                <input 
                  className="form-input" 
                  autoFocus
                  placeholder="e.g. Ahmed Ali"
                  value={newCustomer.name}
                  onChange={e => setNewCustomer({ ...newCustomer, name: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Phone *</label>
                <input 
                  className="form-input" 
                  required
                  placeholder="e.g. 01012345678"
                  value={newCustomer.phone}
                  onChange={e => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-lg)' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddCustomer(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={addingCustomer || !newCustomer.phone}>
                  {addingCustomer ? 'Adding...' : 'Add Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
