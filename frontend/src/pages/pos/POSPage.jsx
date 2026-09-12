import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { inventoryAPI, customersAPI, storesAPI, salesAPI, barcodesAPI } from '../../api';
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
  HiOutlineCamera,
  HiOutlineEye,
  HiOutlineEyeSlash,
  HiOutlineXMark,
  HiOutlineFunnel,
  HiOutlineChevronRight
} from 'react-icons/hi2';
import CheckoutModal from './CheckoutModal';
import ReceiptModal from '../../components/sales/ReceiptModal';
import ShiftBanner from './ShiftBanner';
import DiscountRequestModal from './DiscountRequestModal';
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
  // A till is a touch screen: one tap on a chip beats opening a dropdown.
  const [categoryId, setCategoryId] = useState('');
  const [sizeValues, setSizeValues] = useState([]);
  const [colors, setColors] = useState([]);

  /**
   * The chips come from stock, not from the catalogue.
   *
   * Sizes used to be built from the chosen category's whole size list — EU 30 to 50
   * for a shop that carries 40 to 45. Most of those buttons found nothing, and a
   * cashier learns quickly to distrust a control that usually returns an empty grid.
   * `/inventory/facets` returns only what is actually on the shelves, with a count on
   * each chip, and it is three grouped counts rather than the row dump the till was
   * using to work the same thing out.
   */
  const [facets, setFacets] = useState({ colors: [], sizes: [], categories: [] });

  /**
   * Prices off the screen.
   *
   * A till faces the customer. There are moments — a shelf count, a colleague looking
   * over the counter, a phone camera in a queue — where the wall of prices is the last
   * thing that should be on display. This hides every figure on this screen behind
   * dots; the checkout dialog still shows real amounts, because money cannot be taken
   * blind and that dialog is open for seconds, deliberately, with one person reading it.
   */
  const [hidePrices, setHidePrices] = useState(() => localStorage.getItem('pos_hide_prices') === '1');

  /**
   * Size and colour rows are behind a toggle; category is always on show.
   *
   * Three chip rows on a phone cost about 90px, and the product grid is what that
   * comes out of — the same vertical squeeze the cart had. Category is the one a
   * cashier reaches for constantly, so it stays; the other two open on a tap, and stay
   * open on their own whenever one of them is actually filtering something.
   */
  const [showFilters, setShowFilters] = useState(false);

  // The sale just completed, so it can be undone without hunting for it in history.
  const [lastSale, setLastSale] = useState(null);
  const [undoing, setUndoing] = useState(false);

  // What the selected customer already owes, shown before taking more on account.
  const [customerOutstanding, setCustomerOutstanding] = useState(0);

  // The store and customer pickers, which fold away once a sale is under way.
  const [selectorsOpen, setSelectorsOpen] = useState(false);
  
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
  // The receipt is OPTIONAL: never opened automatically, always one button away.
  const [receiptFor, setReceiptFor] = useState(null);
  const [showDiscount, setShowDiscount] = useState(false);
  // An approval the manager has granted and this cart is being sold against.
  const [approval, setApproval] = useState(null);
  // A manager's approval for leaving part of this sale unpaid.
  const [creditApproval, setCreditApproval] = useState(null);
  const [showCredit, setShowCredit] = useState(false);
  // The branch's open drawer, so a cashier can see they are selling into one.
  const [shift, setShift] = useState(null);
  // The selling code, at branches that ask for one.
  const [sellerCode, setSellerCode] = useState('');
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

  useEffect(() => {
    localStorage.setItem('pos_hide_prices', hidePrices ? '1' : '0');
  }, [hidePrices]);

  /** A money figure, or dots when prices are hidden. */
  const priceText = (value, opts) => (hidePrices
    ? '•••'
    : Number(value || 0).toLocaleString(undefined, opts));

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

  const handleSearch = async (e, category = categoryId, sizes = sizeValues, cols = colors) => {
    if (e) e.preventDefault();
    if (!selectedStore) return;

    try {
      setSearching(true);
      // One row per product, aggregated in SQL.
      //
      // This used to ask for 5000 `summary` rows and group them in the browser. A
      // summary row is one (product, colour, size, store) combination carrying an
      // image, a price band, a SKU and a barcode — 58 rows and 49 KB to draw 13 cards
      // on this catalogue, and the row count grows as products x colours x sizes while
      // the cards grow as products. The real danger was not the bytes: past 5000 rows
      // the catalogue was silently truncated and stock simply did not appear.
      const res = await inventoryAPI.productGrid({
        store_id: selectedStore,
        search: searchQuery,
        // Sent from the arguments, not from state: the chip handlers call this in the
        // same tick they set the state, when the state would still be the old value.
        ...(category ? { category_id: category } : {}),
        ...(sizes.length ? { size_values: sizes.join(',') } : {}),
        ...(cols.length ? { colors: cols.join(',') } : {}),
        limit: 200
      });

      setProducts((res.data.data || []).map((p) => ({ ...p, quantity: Number(p.quantity) })));
    } catch (err) {
      toast.error(t('pos.sale_failed'));
    } finally {
      setSearching(false);
    }
  };

  /**
   * Undo the sale just rung up.
   *
   * A mis-scan is noticed immediately, and the fix has to be one button at the till —
   * not a trip to sales history. The stock goes back and the sale is marked voided;
   * nothing is deleted, so what happened is still on the record.
   */
  useEffect(() => {
    if (!selectedCustomer) { setCustomerOutstanding(0); return; }
    salesAPI.customerBalance(selectedCustomer, selectedStore ? { store_id: selectedStore } : {})
      .then((r) => setCustomerOutstanding(r.data.data.outstanding || 0))
      .catch(() => setCustomerOutstanding(0));
  }, [selectedCustomer, selectedStore]);

  const handleUndoLastSale = async () => {
    if (!lastSale) return;
    if (!confirm(t('pos.undo_confirm', { number: lastSale.number }))) return;
    try {
      setUndoing(true);
      await salesAPI.void(lastSale.id, { reason: t('pos.undo_reason') });
      toast.success(t('pos.sale_undone', { number: lastSale.number }));
      setLastSale(null);
      handleSearch();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setUndoing(false); }
  };

  /**
   * Reload the chips whenever the store or a filter changes.
   *
   * Each facet is computed server-side with every filter EXCEPT its own, so picking
   * "Black" narrows the sizes and the categories but leaves the other colours on
   * offer. Without that, choosing one colour empties the colour row and the only way
   * to a different colour is to clear the filter — a dead end that reads as a broken
   * screen rather than as a filter working.
   */
  useEffect(() => {
    if (!selectedStore) { setFacets({ colors: [], sizes: [], categories: [] }); return; }
    inventoryAPI.facets({
      store_id: selectedStore,
      ...(categoryId ? { category_id: categoryId } : {}),
      ...(sizeValues.length ? { size_values: sizeValues.join(',') } : {}),
      ...(colors.length ? { colors: colors.join(',') } : {}),
    })
      .then((r) => setFacets(r.data.data || { colors: [], sizes: [], categories: [] }))
      .catch(() => { /* the chips are a convenience; the till still opens without them */ });
  }, [selectedStore, categoryId, sizeValues, colors]);

  const toggleSize = (value) => {
    const next = sizeValues.includes(value)
      ? sizeValues.filter((v) => v !== value)
      : [...sizeValues, value];
    setSizeValues(next);
    handleSearch(null, categoryId, next, colors);
  };

  const toggleColor = (name) => {
    const next = colors.includes(name)
      ? colors.filter((v) => v !== name)
      : [...colors, name];
    setColors(next);
    handleSearch(null, categoryId, sizeValues, next);
  };

  const filterCount = (categoryId ? 1 : 0) + sizeValues.length + colors.length;

  const clearFilters = () => {
    setCategoryId('');
    setSizeValues([]);
    setColors([]);
    handleSearch(null, '', [], []);
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
      
      // Paying nothing now is a sale wholly on account: send no payment at all rather
      // than a zero one, which the server would reject as below its minimum.
      const paying = paymentDetails.amount === undefined ? total : paymentDetails.amount;
      const payload = {
        store_id: selectedStore,
        customer_id: selectedCustomer || null,
        items: cart.map(item => ({ id: item.id, sale_price: parseFloat(item.sale_price) || 0 })),
        // Only ever an amount a manager actually approved. The server checks it again
        // against the approval, so this is a convenience, not the guard.
        discount_amount: approval ? Number(approval.approved_discount) : 0,
        ...(approval ? { discount_request_id: approval.id } : {}),
        ...(creditApproval ? { credit_request_id: creditApproval.id } : {}),
        ...(sellerCode ? { seller_code: sellerCode } : {}),
        notes: '',
        payments: paying > 0 ? [{
          amount: paying,
          payment_method: paymentDetails.method,
          reference_no: paymentDetails.reference || ''
        }] : []
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

      // Held so the cashier can undo it without going to sales history. Cleared as
      // soon as the next sale starts — "the last sale" has to be unambiguous.
      setLastSale({
        id: res.data.data.id,
        number: res.data.data.sale_number,
        total: res.data.data.final_amount,
      });
      setApproval(null);
      setCreditApproval(null);
      setSellerCode('');
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
  // What the customer actually pays once an approved discount is applied.
  const payable = Math.max(0, total - (approval ? Number(approval.approved_discount) : 0));
  // Whether this person can simply type a discount, or has to ask. The server decides
  // for real; this only chooses which control to show.
  const canDiscountFreely = user?.role_name === 'admin' || Boolean(user?.permissions?.discount_approval);
  // Letting a customer walk out owing money is now a manager's decision, the same way
  // a discount is. Someone who may approve it does not have to ask themselves.
  const canCreditFreely = user?.role_name === 'admin' || Boolean(user?.permissions?.credit_approval);

  /**
   * May this person price away from the marked price at all?
   *
   * A cashier sells at the price on the label. If the customer wants less, that is a
   * discount request, which a manager answers — it is not a number the cashier edits.
   * The band itself is stripped from the API response for these users
   * (backend/src/middleware/priceVisibility.js), so there is nothing here to leak even
   * if this flag were wrong.
   */
  const canSetPrice = user?.role_name === 'admin' || Boolean(user?.permissions?.price_override);
  const needsSellerCode = Boolean(shift?.require_seller_passcode)
    || Boolean(stores.find((s) => s.id === selectedStore)?.require_seller_passcode);

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
                type="search"
                enterKeyHint="search"
                placeholder={t('pos.search_products')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
            </form>
          </div>
          <button className="btn btn-primary pos-search-submit" onClick={handleSearch} disabled={searching || !selectedStore}>
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
          <button
            className={`btn ${showFilters || sizeValues.length || colors.length ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => setShowFilters((v) => !v)}
            disabled={!selectedStore}
            title={t('common.filters')}
            data-testid="pos-toggle-filters"
          >
            <HiOutlineFunnel size={18} />
            {sizeValues.length + colors.length > 0 && (
              <span className="pos-chip-count">{sizeValues.length + colors.length}</span>
            )}
          </button>
          <button
            className={`btn ${hidePrices ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => setHidePrices((v) => !v)}
            title={t(hidePrices ? 'pos.show_prices' : 'pos.hide_prices')}
            aria-label={t(hidePrices ? 'pos.show_prices' : 'pos.hide_prices')}
            aria-pressed={hidePrices}
            data-testid="pos-toggle-prices"
          >
            {hidePrices ? <HiOutlineEyeSlash size={18} /> : <HiOutlineEye size={18} />}
          </button>
        </div>

        {/* Three chip rows, each independent of the others: a cashier can ask for
            "shoes, size 42, black" or for any one of the three on its own. Every chip
            carries the number of pairs behind it, so nothing on offer finds nothing. */}
        {facets.categories.length > 0 && (
          <div className="pos-category-chips" data-testid="pos-categories">
            <button
              type="button"
              className={`pos-category-chip ${categoryId === '' ? 'pos-category-chip--on' : ''}`}
              data-testid="pos-category-all"
              disabled={!selectedStore}
              onClick={() => { setCategoryId(''); setSizeValues([]); handleSearch(null, '', [], colors); }}
            >
              {t('common.all')}
            </button>
            {facets.categories.filter((c) => c.category_id).map((c) => (
              <button
                key={c.category_id}
                type="button"
                className={`pos-category-chip ${categoryId === c.category_id ? 'pos-category-chip--on' : ''}`}
                data-testid={`pos-category-${c.category_id}`}
                disabled={!selectedStore}
                onClick={() => {
                  const next = categoryId === c.category_id ? '' : c.category_id;
                  setCategoryId(next);
                  // Sizes belong to a category's own scale: '80' is not a sock size,
                  // and carried across it would filter to nothing and read as missing
                  // stock rather than as a stale filter.
                  setSizeValues([]);
                  handleSearch(null, next, [], colors);
                }}
              >
                {localizedName({ name_en: c.name_en, name_ar: c.name_ar }, locale)}
                <span className="pos-chip-count">{c.count}</span>
              </button>
            ))}
          </div>
        )}

        {(showFilters || sizeValues.length > 0) && facets.sizes.length > 0 && (
          <div className="pos-category-chips" data-testid="pos-sizes">
            <span className="pos-chip-label">{t('products.size_generic')}</span>
            {facets.sizes.map((v) => (
              <button
                key={v.value}
                type="button"
                className={`pos-category-chip ${sizeValues.includes(v.value) ? 'pos-category-chip--on' : ''}`}
                data-testid={`pos-size-${v.value}`}
                disabled={!selectedStore}
                onClick={() => toggleSize(v.value)}
              >
                {formatSize({ ...v, size_eu: v.value }, locale) || v.value}
                <span className="pos-chip-count">{v.count}</span>
              </button>
            ))}
          </div>
        )}

        {(showFilters || colors.length > 0) && facets.colors.length > 0 && (
          <div className="pos-category-chips" data-testid="pos-colors">
            <span className="pos-chip-label">{t('pos.color')}</span>
            {facets.colors.map((c) => (
              <button
                key={c.name}
                type="button"
                className={`pos-category-chip ${colors.includes(c.name) ? 'pos-category-chip--on' : ''}`}
                data-testid={`pos-color-${c.name}`}
                disabled={!selectedStore}
                onClick={() => toggleColor(c.name)}
              >
                {c.hex_code && <span className="pos-color-dot" style={{ background: c.hex_code }} aria-hidden="true" />}
                {c.name}
                <span className="pos-chip-count">{c.count}</span>
              </button>
            ))}
          </div>
        )}

        {filterCount > 0 && (
          <div className="pos-category-chips">
            <button type="button" className="pos-category-chip pos-category-chip--clear"
              data-testid="pos-clear-filters" onClick={clearFilters}>
              <HiOutlineXMark size={14} /> {t('pos.clear_filters', { n: filterCount })}
            </button>
          </div>
        )}

        {/* Undo sits where the sale just happened, and only for the sale just made. */}
        {lastSale && (
          <div className="pos-undo-strip" data-testid="pos-undo-strip">
            <span>{t('pos.last_sale', { number: lastSale.number })}</span>
            {/* Offered, never forced: most customers take a bag, not a docket, and a
                print dialog after every sale teaches staff to dismiss dialogs. */}
            <button className="btn btn-sm btn-secondary" data-testid="pos-receipt"
              onClick={() => setReceiptFor(lastSale.id)}>
              {t('receipt.show')}
            </button>
            <button className="btn btn-sm btn-danger" data-testid="pos-undo-sale"
              disabled={undoing} onClick={handleUndoLastSale}>
              {undoing ? '…' : t('pos.undo_sale')}
            </button>
          </div>
        )}

        <ShiftBanner storeId={selectedStore} onChange={setShift} />

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
                    <span className="pos-product-price" data-testid="pos-card-price">
                      {priceText(item.store_selling_price || item.default_selling_price || 0)}
                      {!hidePrices && <> <span className="currency">{t('common.currency')}</span></>}
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

        {/* Folded away once the sale is under way: the store and the customer are
            picked once and then only take up room the item list needs. One tap brings
            them back, and what they are set to is always on screen. */}
        {cart.length > 0 && !selectorsOpen && (
          <button type="button" className="pos-cart-context" data-testid="pos-cart-context"
            onClick={() => setSelectorsOpen(true)}>
            <span>
              <HiOutlineBuildingStorefront />{' '}
              {stores.find((x) => x.id === selectedStore)?.name || t('pos.select_store')}
              {' · '}
              <HiOutlineUser />{' '}
              {selectedCustomer
                ? (customers.find((c) => c.id === selectedCustomer)?.name
                   || customers.find((c) => c.id === selectedCustomer)?.phone)
                : t('pos.walk_in')}
            </span>
            <span className="pos-cart-context-edit">{t('common.edit')}</span>
          </button>
        )}

        {/* Store & Customer Selectors */}
        {(cart.length === 0 || selectorsOpen) && (
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
            {/* A div, not a label. A <label> may not contain interactive content, and
                Chrome answers by dropping the nested button out of the accessibility
                tree — so a screen reader, and anything querying by role, could not see
                the Quick Add button at all even though it was plainly on screen. */}
            <div className="form-label pos-customer-label">
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><HiOutlineUser /> {t('pos.customer')}</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost pos-quick-add-btn"
                data-testid="pos-quick-add-customer"
                onClick={() => setShowAddCustomer(true)}
              >
                + {t('pos.quick_add_customer')}
              </button>
            </div>
            <SearchableSelect
              options={[
                { value: '', label: `— ${t('pos.walk_in')} —` },
                ...customers.map(c => ({ value: c.id, label: `${c.name || t('common.name')} (${c.phone})` }))
              ]}
              value={selectedCustomer}
              onChange={(e) => setSelectedCustomer(e.target.value)}
            />
            {customerOutstanding > 0 && (
              <small style={{ color: 'var(--color-danger)' }} data-testid="pos-customer-balance">
                {t('loans.outstanding')}: {priceText(customerOutstanding)}{!hidePrices && ` ${t('common.currency')}`}
              </small>
            )}
          </div>
          {cart.length > 0 && (
            <button type="button" className="btn btn-sm btn-secondary"
              onClick={() => setSelectorsOpen(false)}>{t('common.close')}</button>
          )}
        </div>
        )}

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
                      {/* Was `t('pos.select_size')` followed by the raw value, so every
                          cart line read "Select Size 44" — a form label used as a
                          prefix. formatSize also writes it the way the category does,
                          so a sock reads "Kids" rather than "Select Size KIDS". */}
                      <div className="pos-cart-item-variant">
                        {[formatSize(item, locale), formatColor(item)].filter(Boolean).join(' • ') || '—'}
                      </div>
                      {/* The floor and ceiling are shown only to somebody who is
                          allowed to move a price between them. To everyone else the
                          band does not exist, and the server does not send it. */}
                      {!isValid && !hidePrices && canSetPrice && (
                        <div className="pos-cart-item-error">
                          {minP} - {maxP < 999999 ? maxP : '∞'} {t('common.currency')}
                        </div>
                      )}
                    </div>
                    <div className="pos-cart-item-actions">
                      {hidePrices ? (
                        // Read-only rather than a masked input you can still type into:
                        // editing a price you cannot see is how a wrong number gets
                        // banked. Unhiding is one tap away.
                        <span className="form-input price-input pos-price-masked" data-testid="pos-cart-price-masked">•••</span>
                      ) : (
                        canSetPrice ? (
                          <input
                            type="number"
                            className="form-input price-input"
                            data-testid={`pos-price-${index}`}
                            style={{ borderColor: isValid ? undefined : 'var(--color-danger)', background: isValid ? undefined : 'rgba(var(--color-danger-rgb), 0.1)' }}
                            value={item.sale_price}
                            onChange={e => updateCartItemPrice(index, e.target.value)}
                            step="0.01"
                          />
                        ) : (
                          // Not a disabled input: a greyed-out box invites a cashier to
                          // keep clicking it. This is simply the price, with the way to
                          // change it being the discount button below.
                          <span className="form-input price-input pos-price-fixed"
                            data-testid={`pos-price-fixed-${index}`}>
                            {Number(item.sale_price).toLocaleString()}
                          </span>
                        )
                      )}
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
          {approval && (
            <div className="pos-cart-totals-row pos-approved-discount" data-testid="pos-approval">
              <span>{t('pos.approved_discount', { number: approval.request_number })}</span>
              <span>
                -{priceText(Number(approval.approved_discount), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                <button type="button" className="pos-approval-clear"
                  title={t('common.remove')} onClick={() => setApproval(null)}>×</button>
              </span>
            </div>
          )}
          <div className="pos-cart-totals-grand">
            <span>{t('pos.total_amount')}</span>
            <span style={{ color: 'var(--color-success)' }} data-testid="pos-total">
              {priceText(payable, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              {!hidePrices && ` ${t('common.currency')}`}
            </span>
          </div>
        </div>

        {/* A cashier who may not discount can still ASK. The button is the whole point
            of the approval queue: without it the answer to "can I take 50 off?" is a
            manager walking over and typing their own password into someone else's
            session, which is how a manager's password becomes common knowledge. */}
        {cart.length > 0 && !approval && !canDiscountFreely && (
          <button type="button" className="btn btn-secondary pos-ask-discount"
            data-testid="pos-ask-discount" onClick={() => setShowDiscount(true)}>
            {t('pos.ask_for_discount')}
          </button>
        )}

        {/* The same shape for pay-later. Only offered once a registered customer is
            chosen, because there is no one to collect from otherwise — and offering a
            button that always fails is worse than not offering it. */}
        {cart.length > 0 && selectedCustomer && !creditApproval && !canCreditFreely && (
          <button type="button" className="btn btn-secondary pos-ask-discount"
            data-testid="pos-ask-credit" onClick={() => setShowCredit(true)}>
            {t('credit.ask_button')}
          </button>
        )}

        {creditApproval && (
          <div className="pos-cart-totals-row pos-approved-discount" data-testid="pos-credit-approval">
            <span>{t('credit.approved_for', { number: creditApproval.request_number })}</span>
            <span>
              {priceText(Number(creditApproval.approved_credit), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              <button type="button" className="pos-approval-clear"
                title={t('common.remove')} onClick={() => setCreditApproval(null)}>×</button>
            </span>
          </div>
        )}

        {needsSellerCode && cart.length > 0 && (
          <div className="form-group pos-seller-code">
            <label className="form-label" htmlFor="pos-seller-code">{t('pos.selling_code')}</label>
            <input id="pos-seller-code" className="form-input" type="password"
              autoComplete="off" data-testid="pos-seller-code"
              value={sellerCode} onChange={(e) => setSellerCode(e.target.value)} />
            <div className="form-hint">{t('pos.selling_code_hint')}</div>
          </div>
        )}

        <button 
          className="btn btn-primary pos-checkout-btn"
          disabled={!isCartValid || (needsSellerCode && !sellerCode)}
          onClick={() => setShowCheckout(true)}
        >
          {t('pos.checkout')}
          {' — '}
          {priceText(payable, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          {!hidePrices && ` ${t('common.currency')}`}
        </button>
      </div>

      {/* Mobile bottom action bar (shown on products tab) — a full-width, thumb-height
          jump to the cart that shows what is in it and the running total. */}
      {cart.length > 0 && mobileTab === 'products' && (
        <button className="pos-mobile-fab" onClick={() => setMobileTab('cart')}>
          <span className="pos-mobile-fab-left">
            <HiOutlineShoppingBag size={20} />
            <span className="pos-mobile-fab-badge">{cart.length}</span>
            <span className="pos-mobile-fab-label">{t('pos.view_cart')}</span>
          </span>
          <span className="pos-mobile-fab-total">
            {priceText(total)}{!hidePrices && ` ${t('common.currency')}`}
            <HiOutlineChevronRight size={18} />
          </span>
        </button>
      )}

      {receiptFor && (
        <ReceiptModal saleId={receiptFor} onClose={() => setReceiptFor(null)} />
      )}

      {showDiscount && (
        <DiscountRequestModal
          storeId={selectedStore}
          customerId={selectedCustomer}
          cart={cart}
          total={total}
          onClose={() => setShowDiscount(false)}
          onApproved={(a) => { setApproval(a); setShowDiscount(false); }}
        />
      )}

      {showCredit && (
        <DiscountRequestModal
          kind="credit"
          storeId={selectedStore}
          customerId={selectedCustomer}
          cart={cart}
          total={payable}
          onClose={() => setShowCredit(false)}
          onApproved={(a) => { setCreditApproval(a); setShowCredit(false); }}
        />
      )}

      {showCheckout && (
        <CheckoutModal
          total={Math.max(0, total - (approval ? Number(approval.approved_discount) : 0))}
          onClose={() => setShowCheckout(false)}
          onConfirm={handleCheckout}
          customerName={customers.find((c) => c.id === selectedCustomer)?.name
            || customers.find((c) => c.id === selectedCustomer)?.phone || ''}
          customerOutstanding={customerOutstanding}
          maxUnpaid={canCreditFreely
            ? undefined
            : (creditApproval ? Number(creditApproval.approved_credit) : 0)}
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
