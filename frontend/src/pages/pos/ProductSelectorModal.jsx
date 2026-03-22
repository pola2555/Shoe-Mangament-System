import { useState, useEffect } from 'react';
import { inventoryAPI } from '../../api';
import toast from 'react-hot-toast';

export default function ProductSelectorModal({ product, storeId, cartItemIds, onClose, onAddToCart }) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);

  useEffect(() => {
    fetchItems();
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
      setItems(res.data.data);
    } catch (err) {
      toast.error('Failed to load product variants');
      onClose();
    } finally {
      setLoading(false);
    }
  };

  // Group items by color, then by size
  // Form: { [color_name]: { [size]: [item1, item2, ...] } }
  const groupedItems = items.reduce((acc, item) => {
    const color = item.color_name || 'No Color';
    const size = item.size_eu || 'N/A';
    
    if (!acc[color]) acc[color] = { hex: item.hex_code, sizes: {} };
    if (!acc[color].sizes[size]) acc[color].sizes[size] = [];
    
    acc[color].sizes[size].push(item);
    return acc;
  }, {});

  const price = parseFloat(product.store_selling_price || product.default_selling_price || 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 800, width: '90%' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-lg)' }}>
          <div style={{ display: 'flex', gap: 'var(--spacing-md)', alignItems: 'center' }}>
            <div style={{ width: 80, height: 80, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}>
              {product.product_image ? (
                <img src={product.product_image} alt={product.product_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>No Image</div>
              )}
            </div>
            <div>
              <h2 style={{ marginBottom: '0.25rem' }}>{product.product_name}</h2>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
                <span>{product.brand}</span>
                <span>•</span>
                <span>{product.product_code}</span>
              </div>
              <div style={{ marginTop: '0.5rem', fontWeight: 600, color: 'var(--color-success)', fontSize: '1.2rem' }}>
                {price.toLocaleString()} EGP
              </div>
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        {loading ? (
          <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--color-text-muted)' }}>Loading available items...</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--color-text-muted)' }}>No items currently in stock for this product.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)', maxHeight: '60vh', overflowY: 'auto', paddingRight: '0.5rem' }}>
            {Object.entries(groupedItems).map(([color, data]) => (
              <div key={color} style={{ background: 'var(--color-bg-base)', padding: 'var(--spacing-md)', borderRadius: 'var(--radius-md)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: 'var(--spacing-md)' }}>
                  <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: data.hex || '#ccc', border: '1px solid #444' }}></div>
                  <h3 style={{ fontSize: '1.1rem', margin: 0 }}>{color}</h3>
                </div>
                
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 'var(--spacing-sm)' }}>
                  {/* Sort sizes nicely */}
                  {Object.entries(data.sizes)
                    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
                    .map(([size, sizeItems]) => {
                      // How many of this size are available AND NOT in the cart yet?
                      const availableItems = sizeItems.filter(item => !cartItemIds.has(item.id));
                      const isSoldOut = availableItems.length === 0;
                      
                      return (
                        <div 
                          key={size}
                          onClick={() => {
                            if (!isSoldOut) {
                               // Pop the first available physical item into the cart
                               onAddToCart(availableItems[0]); 
                            }
                          }}
                          style={{
                            padding: 'var(--spacing-sm)',
                            borderRadius: 'var(--radius-sm)',
                            border: `1px solid ${isSoldOut ? 'var(--color-border)' : 'var(--color-primary)'}`,
                            background: isSoldOut ? 'var(--color-bg-secondary)' : 'rgba(var(--color-primary-rgb), 0.1)',
                            opacity: isSoldOut ? 0.5 : 1,
                            cursor: isSoldOut ? 'not-allowed' : 'pointer',
                            textAlign: 'center',
                            transition: 'all 0.2s'
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: '1.1rem', marginBottom: '0.1rem' }}>EU {size}</div>
                          <div style={{ fontSize: '0.75rem', color: isSoldOut ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>
                            {isSoldOut ? 'In Cart / Out' : `${availableItems.length} available`}
                          </div>
                        </div>
                      );
                    })
                  }
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
