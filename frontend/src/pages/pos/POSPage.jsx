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
import { useTranslation } from '../../i18n/i18nContext';
import './POS.css';

export default function POSPage() {
  const { user, filterStores } = useAuth();
  const { t } = useTranslation();
  
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

  // Clear cart when store changes (items belong to a specific store and have store-specific prices)
  const handleStoreChange = (newStoreId) => {
    if (newStoreId !== selectedStore && cart.length > 0) {
      if (!confirm(t('pos.clear_cart') + '?')) return;
    }
    setCart([]);
    setSelectedStore(newStoreId);
  };

  const fetchInitialData = async () => {
    try {
      setLoading(true);
      const [strs, custs] = await Promise.all([
        storesAPI.list(),
        customersAPI.list()
      ]);
      const accessibleStores = filterStores(strs.data.data);
      setStores(accessibleStores);
      setCustomers(custs.data.data);
      
      // Only auto-select store if we don't already have one from localStorage
      if (accessibleStores.length > 0 && !selectedStore) {
        setSelectedStore(accessibleStores[0].id);
      }
    } catch (err) {
      toast.error(t('pos.sale_failed'));
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
      toast.error(t('pos.sale_failed'));
    } finally {
      setSearching(false);
    }
  };

  const addToCart = (physicalItem) => {
    // Use store-specific min/max if available, otherwise fall back to product defaults
    const maxPrice = parseFloat(physicalItem.store_max_selling_price ?? physicalItem.max_selling_price ?? 999999) || 999999;
    const minPrice = parseFloat(physicalItem.store_min_selling_price ?? physicalItem.min_selling_price ?? 0) || 0;
    let defaultPrice = parseFloat(physicalItem.store_selling_price ?? physicalItem.default_selling_price ?? 0) || 0;

    if (defaultPrice > maxPrice) defaultPrice = maxPrice;
    if (defaultPrice < minPrice) defaultPrice = minPrice;

    setCart([...cart, { ...physicalItem, sale_price: defaultPrice }]);
    toast.success(`${t('pos.add_to_cart')}: ${physicalItem.product_name} - ${physicalItem.size_eu}`);
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
      toast.success(t('pos.sale_completed'));
      
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
      toast.error(err.response?.data?.message || t('pos.sale_failed'));
    } finally {
      setCheckingOut(false);
    }
  };

  const total = cart.reduce((sum, item) => sum + (parseFloat(item.sale_price) || 0), 0);

  const isValidPrice = (item) => {
    const price = parseFloat(item.sale_price);
    if (isNaN(price)) return false;
    const min = parseFloat(item.store_min_selling_price ?? item.min_selling_price ?? 0) || 0;
    const max = parseFloat(item.store_max_selling_price ?? item.max_selling_price ?? 999999) || 999999;
    return price >= min && price <= max;
  };
  
  const isCartValid = cart.length > 0 && cart.every(isValidPrice);

  const handleQuickAddCustomer = async (e) => {
    e.preventDefault();
    if (!newCustomer.phone) return toast.error(t('common.phone'));
    try {
      setAddingCustomer(true);
      const res = await customersAPI.create(newCustomer);
      const created = res.data.data;
      setCustomers([...customers, created]);
      setSelectedCustomer(created.id);
      setShowAddCustomer(false);
      setNewCustomer({ name: '', phone: '', notes: '' });
      toast.success(t('pos.add_customer'));
    } catch (err) {
      toast.error(err.response?.data?.message || t('pos.sale_failed'));
    } finally {
      setAddingCustomer(false);
    }
  };

  // -- Render Helpers --
  
  return (
    <div className="pos-layout">
      
      {/* LEFT: Product Selection */}
      <div className="card pos-products-panel">
        <div className="pos-search-bar">
          <div className="pos-search-input-wrap">
            <HiOutlineMagnifyingGlass size={20} color="var(--color-text-muted)" />
            <form onSubmit={handleSearch} style={{ width: '100%' }}>
              <input 
                type="text" 
                placeholder={t('pos.search_products')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
            </form>
          </div>
          <button className="btn btn-primary" onClick={handleSearch} disabled={searching || !selectedStore}>
            {searching ? '...' : t('common.search')}
          </button>
        </div>

        <div className="pos-products-scroll">
          {!selectedStore ? (
            <div className="pos-empty-state">{t('pos.select_store')}</div>
          ) : products.length === 0 ? (
            <div className="pos-empty-state">
              {searching ? t('common.loading') + '...' : t('pos.no_products_found')}
            </div>
          ) : (
            <div className="pos-products-grid">
              {products.map(item => (
                <div 
                  key={item.product_id} 
                  className="card pos-product-card"
                  onClick={() => setSelectedProduct(item)}
                >
                  <div className="pos-product-img">
                    {item.product_image ? (
                      <img src={item.product_image} alt={item.product_name} />
                    ) : (
                      <span className="pos-product-img-placeholder">—</span>
                    )}
                  </div>
                  <div className="pos-product-name">{item.product_name}</div>
                  <div className="pos-product-meta">
                    <span>{item.brand}</span>
                    <span>{item.product_code}</span>
                  </div>
                  <div className="pos-product-footer">
                    <span className="pos-product-price">
                      {parseFloat(item.store_selling_price || item.default_selling_price || 0).toLocaleString()} <span className="currency">{t('common.currency')}</span>
                    </span>
                    <span className="badge badge-info">{item.quantity} {t('pos.stock')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT: Cart & Checkout */}
      <div className="card pos-cart-panel">
        <h3 className="pos-cart-title">
          <HiOutlineShoppingBag /> {t('pos.title')}
        </h3>

        {/* Store & Customer Selectors */}
        <div className="pos-cart-selectors">
          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><HiOutlineBuildingStorefront /> {t('pos.store')}</label>
            <SearchableSelect
              options={stores.map(s => ({ value: s.id, label: s.name }))}
              value={selectedStore}
              onChange={(e) => handleStoreChange(e.target.value)}
              placeholder={t('pos.select_store')}
            />
          </div>
          <div className="form-group">
            <label className="form-label pos-customer-label">
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><HiOutlineUser /> {t('pos.customer')}</span>
              <button 
                type="button" 
                className="btn btn-sm btn-ghost pos-quick-add-btn"
                onClick={() => setShowAddCustomer(true)}
              >
                + {t('pos.quick_add_customer')}
              </button>
            </label>
            <SearchableSelect
              options={[
                { value: '', label: `— ${t('pos.walk_in')} —` },
                ...customers.map(c => ({ value: c.id, label: `${c.name || t('common.name')} (${c.phone})` }))
              ]}
              value={selectedCustomer}
              onChange={(e) => setSelectedCustomer(e.target.value)}
            />
          </div>
        </div>

        {/* Cart Items */}
        <div className="pos-cart-items">
          {cart.length === 0 ? (
            <div className="pos-cart-empty">{t('pos.cart_empty')}</div>
          ) : (
            <div className="pos-cart-list">
              {cart.map((item, index) => {
                const isValid = isValidPrice(item);
                const minP = parseFloat(item.min_selling_price || 0);
                const maxP = parseFloat(item.max_selling_price || 999999);
                return (
                  <div key={`${item.id}-${index}`} className="pos-cart-item">
                    <div className="pos-cart-item-info">
                      <div className="pos-cart-item-name">{item.product_name || item.sku}</div>
                      <div className="pos-cart-item-variant">
                        {t('pos.select_size')} {item.size_eu} • {item.color_name || '—'}
                      </div>
                      {!isValid && (
                        <div className="pos-cart-item-error">
                          {minP} - {maxP < 999999 ? maxP : '∞'} {t('common.currency')}
                        </div>
                      )}
                    </div>
                    <div className="pos-cart-item-actions">
                      <input
                        type="number"
                        className="form-input price-input"
                        style={{ borderColor: isValid ? undefined : 'var(--color-danger)', background: isValid ? undefined : 'rgba(var(--color-danger-rgb), 0.1)' }}
                        value={item.sale_price}
                        onChange={e => updateCartItemPrice(index, e.target.value)}
                        step="0.01"
                      />
                      <span className="currency-label">{t('common.currency')}</span>
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
        <div className="pos-cart-totals">
          <div className="pos-cart-totals-row">
            <span>{t('pos.items_in_cart')}</span>
            <span>{cart.length}</span>
          </div>
          <div className="pos-cart-totals-grand">
            <span>{t('pos.total_amount')}</span>
            <span style={{ color: 'var(--color-success)' }}>{total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('common.currency')}</span>
          </div>
        </div>

        <button 
          className="btn btn-primary pos-checkout-btn"
          disabled={!isCartValid}
          onClick={() => setShowCheckout(true)}
        >
          {t('pos.checkout')} — {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t('common.currency')}
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
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>{t('pos.quick_add_customer')}</h2>
            <form onSubmit={handleQuickAddCustomer}>
              <div className="form-group">
                <label className="form-label">{t('common.name')}</label>
                <input 
                  className="form-input" 
                  autoFocus
                  placeholder={t('common.name')}
                  value={newCustomer.name}
                  onChange={e => setNewCustomer({ ...newCustomer, name: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">{t('common.phone')} *</label>
                <input 
                  className="form-input" 
                  required
                  placeholder={t('common.phone')}
                  value={newCustomer.phone}
                  onChange={e => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-lg)' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddCustomer(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={addingCustomer || !newCustomer.phone}>
                  {addingCustomer ? t('pos.processing') : t('pos.add_customer')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
