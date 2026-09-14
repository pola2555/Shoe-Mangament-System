import { useState, useEffect } from 'react';
import { inventoryAPI } from '../../api';
import toast from 'react-hot-toast';
import { HiOutlineXMark } from 'react-icons/hi2';
import { useTranslation } from '../../i18n/i18nContext';
import { formatSize, formatColor, compareSize } from '../../utils/variantFormat';
import ClickableImage from '../../components/common/ClickableImage';
import './POS.css';

export default function ProductSelectorModal({ product, storeId, cartItemIds, onClose, onAddToCart }) {
  const { t, locale } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);

  useEffect(() => {
    fetchItems();
    // Close on Escape, like every other modal should.
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.product_id, storeId]);

  const fetchItems = async () => {
    try {
      setLoading(true);
      // Fetch all sellable inventory items for this specific product + store
      const res = await inventoryAPI.list({
        store_id: storeId,
        product_id: product.product_id,
        status: 'in_stock'
      });
      // Oldest pair first, so tapping a size sells the pair that has been sitting
      // longest — the same rule the barcode scanner already follows.
      //
      // The list comes back newest-first (that is the right order for the inventory
      // PAGE, which is why it is reversed here rather than there). Taking it as it
      // came meant scanning and tapping handed out different pairs: the new stock
      // went out first and the old stock aged at the back of the shelf, which also
      // pushed reported margin around, since every pair carries its own cost.
      setItems([...res.data.data].sort(
        (a, b) => new Date(a.created_at) - new Date(b.created_at)
      ));
    } catch (err) {
      toast.error(t('pos.failed_to_load_variants'));
      onClose();
    } finally {
      setLoading(false);
    }
  };

  // Group items by color, then by size
  // Form: { [color_name]: { hex, colorImage, colorImageThumb, sizes: { [size]: [item...] } } }
  const groupedItems = items.reduce((acc, item) => {
    const color = formatColor(item) || '';
    const size = item.size_eu || 'N/A';

    if (!acc[color]) acc[color] = {
      hex: item.hex_code,
      colorImage: item.color_image_url || null,
      colorImageThumb: item.color_image_thumb_url || null,
      sizes: {},
    };
    if (!acc[color].sizes[size]) acc[color].sizes[size] = [];

    acc[color].sizes[size].push(item);
    return acc;
  }, {});

  const price = parseFloat(product.store_selling_price || product.default_selling_price || 0);

  return (
    <div className="modal-overlay pos-selector-modal" onClick={onClose}>
      <div className="modal-content card pos-selector" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="pos-selector-head">
          <div className="pos-selector-thumb">
            {product.product_image ? (
              <ClickableImage
                src={product.product_image}
                thumbSrc={product.product_image_thumb}
                alt={product.product_name}
                title={product.product_name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <span className="pos-selector-thumb-empty">{t('products.no_image')}</span>
            )}
          </div>
          <div className="pos-selector-titles">
            <h2 className="pos-selector-name">{product.product_name}</h2>
            <div className="pos-selector-sub">
              {product.brand && <span>{product.brand}</span>}
              {product.brand && product.product_code && <span className="pos-selector-dot">•</span>}
              {product.product_code && <span>{product.product_code}</span>}
            </div>
            <div className="pos-selector-price">
              {price.toLocaleString()} <span className="currency">{t('common.currency')}</span>
            </div>
          </div>
          <button className="pos-selector-close" onClick={onClose} aria-label={t('common.close')}>
            <HiOutlineXMark size={22} />
          </button>
        </div>

        {loading ? (
          <div className="pos-selector-state">{t('common.loading')}…</div>
        ) : items.length === 0 ? (
          <div className="pos-selector-state">{t('pos.no_products_found')}</div>
        ) : (
          <>
            <div className="pos-selector-hint">{t('pos.tap_size_hint')}</div>
            <div className="pos-selector-body">
              {Object.entries(groupedItems).map(([color, data]) => {
                const totalInColor = Object.values(data.sizes)
                  .reduce((n, arr) => n + arr.filter(i => !cartItemIds.has(i.id)).length, 0);
                return (
                  <section key={color} className="pos-color-group">
                    {color && (
                      <div className="pos-color-head">
                        {(data.colorImage || product.product_image) && (
                          <ClickableImage
                            src={data.colorImage || product.product_image}
                            thumbSrc={data.colorImageThumb || product.product_image_thumb}
                            alt={color}
                            title={`${product.product_name} — ${color}`}
                            className="pos-color-img"
                          />
                        )}
                        <span className="pos-color-swatch" style={{ backgroundColor: data.hex || '#ccc' }} aria-hidden="true" />
                        <span className="pos-color-name">{color}</span>
                        <span className="pos-color-count">{totalInColor} {t('pos.available')}</span>
                      </div>
                    )}

                    <div className="pos-size-grid">
                      {Object.entries(data.sizes)
                        .sort(([, a], [, b]) => compareSize(a[0], b[0]))
                        .map(([size, sizeItems]) => {
                          const availableItems = sizeItems.filter(item => !cartItemIds.has(item.id));
                          const isSoldOut = availableItems.length === 0;
                          return (
                            <button
                              key={size}
                              type="button"
                              className={`pos-size-tile ${isSoldOut ? 'pos-size-tile--out' : ''}`}
                              disabled={isSoldOut}
                              onClick={() => { if (!isSoldOut) onAddToCart(availableItems[0]); }}
                            >
                              <span className="pos-size-tile-size">
                                {formatSize(sizeItems[0], locale) || t('pos.add_to_cart')}
                              </span>
                              <span className="pos-size-tile-stock">
                                {isSoldOut ? t('pos.out_of_stock') : `${availableItems.length} ${t('pos.available')}`}
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
