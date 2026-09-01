import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { inventoryAPI, customersAPI, storesAPI, salesAPI, barcodesAPI, productCategoriesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { formatSize, formatColor, localizedName } from '../../utils/variantFormat';
import SearchableSelect from '../../components/common/SearchableSelect';
import {
  HiOutlineShoppingBag,
  HiOutlineUser,
  HiOutlineBuildingStorefront,
  HiOutlineTrash,
  HiOutlineMagnifyingGlass,
  HiOutlineUserPlus,
  HiOutlineQrCode,
  HiOutlineCamera
} from 'react-icons/hi2';
import CheckoutModal from './CheckoutModal';
import ProductSelectorModal from './ProductSelectorModal';
import { useTranslation } from '../../i18n/i18nContext';
import useBarcodeScanner from '../../hooks/useBarcodeScanner';
import './POS.css';

// ZXing is ~300 kB. Loading the scanner lazily keeps it out of the POS entry chunk;
// it only arrives if the cashier actually opens the camera.
const BarcodeScannerModal = lazy(() => import('../../components/barcode/BarcodeScannerModal'));

export default function POSPage() {
  const { user, filterStores } = useAuth();
  const { t, locale } = useTranslation();
  
  // Data
  const [stores, setStores] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  
  // State
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categories, setCategories] = useState([]);
  // A till is a touch screen: one tap on a chip beats opening a dropdown.
  const [categoryId, setCategoryId] = useState('');
  
  // Selection
  const [selectedStore, setSelectedStore] = useState(() => localStorage.getItem('pos_store') || '');
  const [selectedCustomer, setSelectedCustomer] = useState(() => localStorage.getItem('pos_customer') || ''); // Empty = Walk-in
  const [cart, setCart] = useState(() => {
    const saved = localStorage.getItem('pos_cart');
    if (!saved) return [];
    try {
      return JSON.parse(saved);
    } catch {
      localStorage.removeItem('pos_cart');
      return [];
    }
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

  // Mobile tab: 'products' or 'cart'
  const [mobileTab, setMobileTab] = useState('products');

  // Barcode scanning
  const [showScanner, setShowScanner] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [lastScan, setLastScan] = useState(null);   // { ok, text } feedback strip
  // The cart lives in state, but handleScan is memoised for the global key listener;
  // a ref keeps it reading the CURRENT cart instead of the one captured at mount.
  const cartRef = useRef(cart);
  const storeRef = useRef(selectedStore);
  // Serialises overlapping scans so none is lost.
  const scanQueueRef = useRef(Promise.resolve());

  // Initialize
  useEffect(() => { cartRef.current = cart; }, [cart]);
  useEffect(() => { storeRef.current = selectedStore; }, [selectedStore]);

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
      // The chips are a convenience; a failure here must not stop the till opening.
      productCategoriesAPI.list({ is_active: true })
        .then((r) => setCategories(r.data.data || []))
        .catch(() => {});

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

  const handleSearch = async (e, category = categoryId) => {
    if (e) e.preventDefault();
    if (!selectedStore) return;

    try {
      setSearching(true);
      // We need sellable inventory items summarized by product (status is automatically in_stock in summary)
      // A row here is one size of one colour and the grid groups them by product, so
      // the row limit is roughly (products x colours x sizes). 500 rows is only ~20
      // products for a typical catalogue — high enough to bound a runaway query,
      // low enough to silently hide stock from the cashier. Keep it generous.
      const res = await inventoryAPI.summary({
        store_id: selectedStore,
        search: searchQuery,
        // Sent from the argument, not from state: the chip handler calls this in the
        // same tick it sets the state, when `categoryId` would still be the old value.
        ...(category ? { category_id: category } : {}),
        limit: 5000
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

    // Functional update: handleScan is memoised for the global key listener, so a
    // closed-over `cart` would be whatever it was when that callback was created and
    // the second scan of a burst would overwrite the first instead of appending.
    const line = { ...physicalItem, sale_price: defaultPrice };
    cartRef.current = [...cartRef.current, line];   // keep exclude_ids correct for a
                                                    // rescan that lands before React
                                                    // has re-rendered
    setCart((prev) => [...prev, line]);
    toast.success(`${t('pos.add_to_cart')}: ${physicalItem.product_name} - ${physicalItem.size_eu}`);
    // Optional: close modal immediately or let the cashier keep tapping sizes
  };

  /**
   * Resolve a scanned barcode to a concrete pair and drop it in the cart.
   *
   * exclude_ids carries what is already in the cart, so scanning the same size twice
   * adds a SECOND pair rather than returning the one already there — and correctly
   * refuses once stock runs out.
   */
  // handleScan is handed to a global key listener and must keep a stable identity, so
  // it dispatches through a ref rather than capturing runScan from one render.
  const runScanRef = useRef(null);

  const handleScan = useCallback((rawCode) => {
    // Chain onto whatever is already running. Scans must queue, never drop: a cashier
    // running a scanner down a row of boxes fires them faster than a round trip.
    scanQueueRef.current = scanQueueRef.current
      .then(() => runScanRef.current?.(rawCode))
      .catch(() => {});
    return scanQueueRef.current;
  }, []);

  const runScan = useCallback(async (rawCode) => {
    const storeId = storeRef.current;
    if (!storeId) {
      setLastScan({ ok: false, text: t('barcode.select_store_first') });
      toast.error(t('barcode.select_store_first'));
      return;
    }
    try {
      setScanBusy(true);
      const res = await barcodesAPI.lookup({
        code: rawCode,
        store_id: storeId,
        exclude_ids: cartRef.current.map((c) => c.id).join(','),
      });
      const { item } = res.data.data;
      addToCart(item);
      setLastScan({ ok: true, text: [item.product_name, formatColor(item), formatSize(item, locale)].filter(Boolean).join(' · ') });
    } catch (err) {
      const msg = err.response?.data?.message || t('pos.sale_failed');
      setLastScan({ ok: false, text: msg });
      toast.error(msg);
    } finally {
      setScanBusy(false);
    }
    // addToCart is redefined each render, but it only uses setters and refs, so the
    // captured copy behaves identically to a fresh one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => { runScanRef.current = runScan; }, [runScan]);

  // Hardware wedge scanner: active whenever no modal is capturing input.
  useBarcodeScanner(handleScan, { enabled: !showScanner && !showCheckout });

  const onCameraDetected = (code) => {
    setShowScanner(false);
    handleScan(code);
  };

  const updateCartItemPrice = (index, value) => {
    const updated = [...cart];
    updated[index].sale_price = value; // Keep as string or number from input
    setCart(updated);
  };

  const removeFromCart = (index) => {
    setCart((prev) => {
      const next = prev.filter((_, i) => i !== index);
      cartRef.current = next;
      return next;
    });
    // No refetch here: this used to re-query the entire store inventory 100ms after
    // every single removal. The item is still in stock server-side until checkout,
    // so the product list on screen is already correct.
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

      const res = await salesAPI.create(payload);

      // Upload payment proof image if provided
      if (paymentDetails.image && res.data?.data?.payments?.length) {
        const sale = res.data.data;
        const paymentId = sale.payments[0].id;
        const formData = new FormData();
        formData.append('image', paymentDetails.image);
        try {
          await salesAPI.uploadPaymentImage(sale.id, paymentId, formData);
        } catch {
          toast.error(t('pos.image_upload_failed'));
        }
      }

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

      {/* Mobile Tab Bar */}
      <div className="pos-mobile-tabs">
        <button
          className={`pos-mobile-tab ${mobileTab === 'products' ? 'pos-mobile-tab--active' : ''}`}
          onClick={() => setMobileTab('products')}
        >
          <HiOutlineMagnifyingGlass size={18} />
          {t('pos.products_tab')}
        </button>
        <button
          className={`pos-mobile-tab ${mobileTab === 'cart' ? 'pos-mobile-tab--active' : ''}`}
          onClick={() => setMobileTab('cart')}
        >
          <HiOutlineShoppingBag size={18} />
          {t('pos.cart_tab')}
          {cart.length > 0 && <span className="pos-mobile-tab-badge">{cart.length}</span>}
        </button>
      </div>
      
      {/* LEFT: Product Selection */}
      <div className={`card pos-products-panel ${mobileTab === 'products' ? 'pos-panel--active' : ''}`}>
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
          <button
            className="btn btn-secondary"
            onClick={() => setShowScanner(true)}
            disabled={!selectedStore || scanBusy}
            title={t('barcode.scan')}
            aria-label={t('barcode.scan')}
            data-testid="pos-scan-button"
          >
            <HiOutlineCamera size={18} />
          </button>
        </div>

        {categories.length > 0 && (
          <div className="pos-category-chips" data-testid="pos-categories">
            {[{ id: '', label: t('common.all') },
              ...categories.map((c) => ({ id: c.id, label: localizedName(c, locale) }))].map((c) => (
              <button
                key={c.id || 'all'}
                type="button"
                className={`pos-category-chip ${categoryId === c.id ? 'pos-category-chip--on' : ''}`}
                data-testid={`pos-category-${c.id || 'all'}`}
                disabled={!selectedStore}
                onClick={() => { setCategoryId(c.id); handleSearch(null, c.id); }}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {/* Scan feedback. The hardware scanner needs no UI of its own, so this strip
            is the only confirmation the cashier gets that a beep actually landed. */}
        <div className="pos-scan-strip" data-testid="pos-scan-strip">
          <HiOutlineQrCode size={16} />
          {scanBusy ? (
            <span>{t('barcode.decoding')}</span>
          ) : lastScan ? (
            <span
              className={lastScan.ok ? 'pos-scan-ok' : 'pos-scan-err'}
              data-testid={lastScan.ok ? 'scan-ok' : 'scan-err'}
            >
              {lastScan.ok ? '✓ ' : '✕ '}{lastScan.text}
            </span>
          ) : (
            <span className="pos-scan-idle">{t('barcode.scan_hint')}</span>
          )}
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
                      <img
                        src={item.product_image_thumb || item.product_image}
                        alt={item.product_name}
                        loading="lazy"
                        decoding="async"
                      />
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
      <div className={`card pos-cart-panel ${mobileTab === 'cart' ? 'pos-panel--active' : ''}`}>
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

      {/* Mobile floating cart button (shown on products tab) */}
      {cart.length > 0 && mobileTab === 'products' && (
        <button className="pos-mobile-fab" onClick={() => setMobileTab('cart')}>
          <HiOutlineShoppingBag size={24} />
          <span className="pos-mobile-fab-badge">{cart.length}</span>
          <span className="pos-mobile-fab-total">{total.toLocaleString()} {t('common.currency')}</span>
        </button>
      )}

      {showCheckout && (
        <CheckoutModal
          total={total}
          onClose={() => setShowCheckout(false)}
          onConfirm={handleCheckout}
        />
      )}

      {showScanner && (
        <Suspense fallback={null}>
          <BarcodeScannerModal
            onDetected={onCameraDetected}
            onClose={() => setShowScanner(false)}
          />
        </Suspense>
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
