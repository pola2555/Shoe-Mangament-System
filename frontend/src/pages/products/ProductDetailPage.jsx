import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { productsAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import './Products.css';

export default function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { t } = useTranslation();
  const canWrite = hasPermission('products', 'write');

  const [product, setProduct] = useState(null);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('colors');
  const fileInputRef = useRef(null);

  // Form states
  const [colorForm, setColorForm] = useState({ color_name: '', hex_code: '' });
  const [showColorForm, setShowColorForm] = useState(false);
  
  // Single Variant Form
  const [variantForm, setVariantForm] = useState({
    product_color_id: '', size_eu: '', size_us: '', size_uk: '', size_cm: '',
  });
  const [showVariantForm, setShowVariantForm] = useState(false);
  const [generatorMode, setGeneratorMode] = useState(true); // true = smart generator, false = single variant

  // Smart Variant Generator States
  const [genSelectedColors, setGenSelectedColors] = useState([]); // array of color IDs
  const [genSizeStart, setGenSizeStart] = useState('');
  const [genSizeEnd, setGenSizeEnd] = useState('');
  const [genPreview, setGenPreview] = useState([]); // Array of { tempId, product_color_id, size_eu, size_us, size_uk, size_cm }

  // Inline Variant Editing States
  const [editingVariantId, setEditingVariantId] = useState(null);
  const [editVariantForm, setEditVariantForm] = useState({ size_us: '', size_uk: '', size_cm: '', is_active: true });

  const [priceForm, setPriceForm] = useState({
    store_id: '', selling_price: '', min_selling_price: '', max_selling_price: '',
  });
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [uploadColorId, setUploadColorId] = useState(null);

  // Edit Product Info
  const [showEditProduct, setShowEditProduct] = useState(false);
  const [editProductForm, setEditProductForm] = useState({
    brand: '', model_name: '', net_price: '', default_selling_price: '', min_selling_price: '', max_selling_price: '', description: '',
  });

  useEffect(() => { fetchProduct(); fetchStores(); }, [id]);

  const fetchProduct = async () => {
    try {
      setLoading(true);
      const { data } = await productsAPI.getById(id);
      setProduct(data.data);
    } catch {
      toast.error(t('products.no_products'));
      navigate('/products');
    } finally {
      setLoading(false);
    }
  };

  const fetchStores = async () => {
    try {
      const { data } = await storesAPI.list();
      setStores(data.data);
    } catch { /* ignore */ }
  };

  // --- Edit Product ---
  const handleEditProductClick = () => {
    setEditProductForm({
      brand: product.brand || '',
      model_name: product.model_name,
      net_price: product.net_price ?? '',
      default_selling_price: product.default_selling_price ?? '',
      min_selling_price: product.min_selling_price ?? '',
      max_selling_price: product.max_selling_price ?? '',
      description: product.description || '',
    });
    setShowEditProduct(true);
  };

  const handleSaveProduct = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...editProductForm };
      ['net_price', 'default_selling_price', 'min_selling_price', 'max_selling_price'].forEach((f) => {
        payload[f] = payload[f] === '' ? null : parseFloat(payload[f]);
      });
      await productsAPI.update(id, payload);
      toast.success(t('products.product_updated'));
      setShowEditProduct(false);
      fetchProduct();
    } catch (err) {
      toast.error(err.response?.data?.message || t('products.failed_update'));
    }
  };

  // --- Toggle Active ---
  const handleToggleActive = async () => {
    if (!confirm(product.is_active ? t('products.confirm_deactivate') : t('products.confirm_activate'))) return;
    try {
      const { data } = await productsAPI.toggleActive(id);
      toast.success(data.message);
      fetchProduct();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  // --- Colors ---
  const handleAddColor = async (e) => {
    e.preventDefault();
    try {
      await productsAPI.createColor(id, colorForm);
      toast.success(t('products.color_added'));
      setShowColorForm(false);
      setColorForm({ color_name: '', hex_code: '' });
      fetchProduct();
    } catch (err) {
      toast.error(err.response?.data?.message || t('products.failed_add_color'));
    }
  };

  const handleDeleteColor = async (colorId) => {
    if (!confirm(t('products.confirm_delete_color'))) return;
    try {
      await productsAPI.deleteColor(id, colorId);
      toast.success(t('products.color_deleted'));
      fetchProduct();
    } catch (err) { toast.error(err.response?.data?.message || t('products.failed_delete_color')); }
  };

  // --- Images ---
  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !uploadColorId) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      await productsAPI.uploadImage(id, uploadColorId, formData);
      toast.success(t('products.image_uploaded'));
      fetchProduct();
    } catch (err) {
      toast.error(t('products.failed_upload'));
    }
    e.target.value = '';
    setUploadColorId(null);
  };

  const handleDeleteImage = async (imageId) => {
    if (!confirm(t('products.confirm_delete_image'))) return;
    try {
      await productsAPI.deleteImage(id, imageId);
      toast.success(t('products.image_deleted'));
      fetchProduct();
    } catch { toast.error(t('products.failed_delete_image')); }
  };

  const handleSetPrimary = async (imageId) => {
    try {
      await productsAPI.setPrimaryImage(id, imageId);
      toast.success(t('products.primary_image_set'));
      fetchProduct();
    } catch { toast.error(t('products.failed_set_primary')); }
  };

  // --- Variants ---
  const handleAddVariant = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...variantForm };
      payload.size_cm = payload.size_cm === '' ? null : parseFloat(payload.size_cm);
      await productsAPI.createVariant(id, payload);
      toast.success(t('products.variant_added'));
      setShowVariantForm(false);
      setVariantForm({ product_color_id: '', size_eu: '', size_us: '', size_uk: '', size_cm: '' });
      fetchProduct();
    } catch (err) {
      toast.error(err.response?.data?.message || t('products.failed_add_variant'));
    }
  };

  const handleDeleteVariant = async (variantId) => {
    if (!confirm(t('products.confirm_delete_variant'))) return;
    try {
      await productsAPI.deleteVariant(id, variantId);
      toast.success(t('products.variant_deleted'));
      fetchProduct();
    } catch (err) { toast.error(err.response?.data?.message || t('products.failed_delete_variant')); }
  };

  const handleEditVariantClick = (v) => {
    setEditingVariantId(v.id);
    setEditVariantForm({
      size_us: v.size_us || '',
      size_uk: v.size_uk || '',
      size_cm: v.size_cm != null ? v.size_cm : '',
      is_active: v.is_active
    });
  };

  const handleCancelEditVariant = () => {
    setEditingVariantId(null);
  };

  const handleSaveVariantEdit = async (vId) => {
    try {
      const payload = { ...editVariantForm };
      payload.size_cm = payload.size_cm === '' ? null : parseFloat(payload.size_cm);
      await productsAPI.updateVariant(id, vId, payload);
      toast.success(t('products.variant_updated'));
      setEditingVariantId(null);
      fetchProduct();
    } catch (err) {
      toast.error(err.response?.data?.message || t('products.failed_update_variant'));
    }
  };

  // --- Smart Generator Logic ---
  const handleToggleGenColor = (colorId) => {
    setGenSelectedColors((prev) => 
      prev.includes(colorId) ? prev.filter((c) => c !== colorId) : [...prev, colorId]
    );
  };

  const handleGeneratePreview = () => {
    if (genSelectedColors.length === 0) return toast.error(t('products.select_at_least_one_color'));
    const start = parseInt(genSizeStart);
    const end = parseInt(genSizeEnd);
    if (!start || !end || start > end) return toast.error(t('products.valid_size_range'));

    let newPreview = [];
    for (const colorId of genSelectedColors) {
      for (let size = start; size <= end; size++) {
        // Prevent adding if it already exists in the product
        const exists = product.variants.some(v => v.product_color_id === colorId && v.size_eu === String(size));
        if (!exists) {
          newPreview.push({
            tempId: Math.random().toString(36).substring(7),
            product_color_id: colorId,
            size_eu: String(size),
            size_us: '',
            size_uk: '',
            size_cm: ''
          });
        }
      }
    }
    
    if (newPreview.length === 0) {
      toast.success(t('products.combinations_exist'));
    } else {
      setGenPreview(newPreview);
      toast.success(`${t('products.preview_generating')} (${newPreview.length})`);
    }
  };

  const updatePreviewRow = (tempId, field, value) => {
    setGenPreview((prev) => prev.map(p => p.tempId === tempId ? { ...p, [field]: value } : p));
  };

  const deletePreviewRow = (tempId) => {
    setGenPreview((prev) => prev.filter(p => p.tempId !== tempId));
  };

  const handleSaveGeneratedVariants = async () => {
    if (genPreview.length === 0) return;
    try {
      // Group variants by color
      const groups = {};
      genPreview.forEach(g => {
        if (!groups[g.product_color_id]) groups[g.product_color_id] = [];
        const { size_eu, size_us, size_uk, size_cm } = g;
        groups[g.product_color_id].push({
          size_eu,
          size_us: size_us || null,
          size_uk: size_uk || null,
          size_cm: size_cm ? parseFloat(size_cm) : null,
        });
      });

      // Send bulk create requests in parallel for each color group
      const promises = Object.keys(groups).map((colorId) => 
        productsAPI.bulkCreateVariants(id, {
          product_color_id: colorId,
          variants: groups[colorId]
        })
      );

      await Promise.all(promises);
      toast.success(t('products.variants_saved'));
      
      // Reset forms
      setGenPreview([]);
      setShowVariantForm(false);
      fetchProduct();
    } catch (err) {
      toast.error(err.response?.data?.message || t('products.failed_save_variants'));
    }
  };

  // --- Store Prices ---
  const handleSetPrice = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        selling_price: parseFloat(priceForm.selling_price),
        min_selling_price: priceForm.min_selling_price ? parseFloat(priceForm.min_selling_price) : null,
        max_selling_price: priceForm.max_selling_price ? parseFloat(priceForm.max_selling_price) : null,
      };
      await productsAPI.setStorePrice(id, priceForm.store_id, payload);
      toast.success(t('products.store_price_set'));
      setShowPriceForm(false);
      setPriceForm({ store_id: '', selling_price: '', min_selling_price: '', max_selling_price: '' });
      fetchProduct();
    } catch (err) {
      toast.error(err.response?.data?.message || t('products.failed_set_price'));
    }
  };

  const handleDeletePrice = async (storeId) => {
    try {
      await productsAPI.deleteStorePrice(id, storeId);
      toast.success(t('products.store_price_removed'));
      fetchProduct();
    } catch { toast.error(t('products.failed_remove_price')); }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!product) return null;

  return (
    <div className="product-detail">
      {/* Header */}
      <div className="page-header">
        <div>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/products')} style={{ marginBottom: 8 }}>
            ← {t('common.back')}
          </button>
          <h1 className="page-title">{product.brand} {product.model_name}</h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>{t('products.code')}: {product.product_code} &nbsp;•&nbsp;
            {t('products.sell')}: {product.default_selling_price ?? '—'} {t('common.currency')} &nbsp;•&nbsp;
            {t('products.range')}: {product.min_selling_price ?? '—'} – {product.max_selling_price ?? '—'} {t('common.currency')}
          </p>
        </div>
        {canWrite && (
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
            <button className="btn btn-sm btn-secondary" onClick={handleEditProductClick}>✏️ {t('products.edit_info')}</button>
            <button
              className={`btn btn-sm ${product.is_active ? 'btn-danger' : 'btn-primary'}`}
              onClick={handleToggleActive}
            >
              {product.is_active ? `⏸ ${t('common.inactive')}` : `▶ ${t('common.active')}`}
            </button>
          </div>
        )}
      </div>

      {/* Edit Product Modal */}
      {showEditProduct && (
        <div className="modal-overlay" onClick={() => setShowEditProduct(false)}>
          <div className="modal-content card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{t('products.edit_product')}</h2>
            <form onSubmit={handleSaveProduct}>
              <div className="form-group" style={{ marginBottom: 'var(--spacing-sm)' }}>
                <label className="form-label">{t('products.product_code')}</label>
                <input className="form-input" value={product.product_code} disabled style={{ opacity: 0.6 }} />
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('products.brand')}</label>
                  <input className="form-input" value={editProductForm.brand}
                    onChange={(e) => setEditProductForm({ ...editProductForm, brand: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label">{t('products.model_name')} *</label>
                  <input className="form-input" required value={editProductForm.model_name}
                    onChange={(e) => setEditProductForm({ ...editProductForm, model_name: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('products.net_price')}</label>
                  <input className="form-input" type="number" step="0.01" min="0" value={editProductForm.net_price}
                    onChange={(e) => setEditProductForm({ ...editProductForm, net_price: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('products.selling_price')}</label>
                  <input className="form-input" type="number" step="0.01" min="0" value={editProductForm.default_selling_price}
                    onChange={(e) => setEditProductForm({ ...editProductForm, default_selling_price: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('products.min_price')}</label>
                  <input className="form-input" type="number" step="0.01" min="0" value={editProductForm.min_selling_price}
                    onChange={(e) => setEditProductForm({ ...editProductForm, min_selling_price: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('products.max_price')}</label>
                  <input className="form-input" type="number" step="0.01" min="0" value={editProductForm.max_selling_price}
                    onChange={(e) => setEditProductForm({ ...editProductForm, max_selling_price: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">{t('common.description')}</label>
                <textarea className="form-input" rows={3} value={editProductForm.description}
                  onChange={(e) => setEditProductForm({ ...editProductForm, description: e.target.value })} />
              </div>
              <div className="form-actions" style={{ marginTop: 'var(--spacing-md)' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowEditProduct(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{t('products.save_changes')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {['colors', 'variants', 'prices'].map((tab) => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'colors' ? t('products.colors_and_images') : tab === 'variants' ? t('products.size_variants') : t('products.store_prices')}
          </button>
        ))}
      </div>

      {/* === COLORS TAB === */}
      {activeTab === 'colors' && (
        <div className="tab-content">
          {canWrite && (
            <div style={{ marginBottom: 'var(--spacing-lg)' }}>
              {!showColorForm ? (
                <button className="btn btn-primary" onClick={() => setShowColorForm(true)}>+ {t('products.add_color')}</button>
              ) : (
                <form onSubmit={handleAddColor} className="inline-form card">
                  <div className="form-group">
                    <label className="form-label">{t('products.quick_pick_color')}</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 'var(--spacing-sm)' }}>
                      {[
                        { name: 'Black', hex: '#000000' },
                        { name: 'White', hex: '#FFFFFF' },
                        { name: 'Brown', hex: '#8B4513' },
                        { name: 'Tan', hex: '#D2B48C' },
                        { name: 'Beige', hex: '#F5F5DC' },
                        { name: 'Navy', hex: '#000080' },
                        { name: 'Blue', hex: '#2563EB' },
                        { name: 'Red', hex: '#DC2626' },
                        { name: 'Burgundy', hex: '#800020' },
                        { name: 'Green', hex: '#166534' },
                        { name: 'Olive', hex: '#808000' },
                        { name: 'Grey', hex: '#6B7280' },
                        { name: 'Silver', hex: '#C0C0C0' },
                        { name: 'Gold', hex: '#DAA520' },
                        { name: 'Pink', hex: '#EC4899' },
                        { name: 'Orange', hex: '#EA580C' },
                        { name: 'Yellow', hex: '#EAB308' },
                        { name: 'Purple', hex: '#7C3AED' },
                      ].map((c) => (
                        <button
                          key={c.name}
                          type="button"
                          title={c.name}
                          onClick={() => setColorForm({ color_name: c.name, hex_code: c.hex })}
                          style={{
                            width: 32, height: 32, borderRadius: '50%',
                            backgroundColor: c.hex,
                            border: colorForm.hex_code === c.hex ? '3px solid var(--color-accent)' : '2px solid var(--color-border)',
                            cursor: 'pointer',
                            transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                            boxShadow: colorForm.hex_code === c.hex ? '0 0 0 2px var(--color-accent)' : 'none',
                          }}
                          onMouseOver={(e) => e.currentTarget.style.transform = 'scale(1.2)'}
                          onMouseOut={(e) => e.currentTarget.style.transform = 'scale(1)'}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">{t('products.color_name')} *</label>
                      <input className="form-input" required value={colorForm.color_name}
                        onChange={(e) => setColorForm({ ...colorForm, color_name: e.target.value })}
                        placeholder="e.g. Black" />
                    </div>
                    <div className="form-group" style={{ maxWidth: 100 }}>
                      <label className="form-label">{t('products.custom')}</label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="color" value={colorForm.hex_code || '#000000'}
                          onChange={(e) => setColorForm({ ...colorForm, hex_code: e.target.value })}
                          style={{ width: 40, height: 36, border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)', padding: 0, background: 'none' }} />
                        {colorForm.hex_code && (
                          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{colorForm.hex_code}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="form-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowColorForm(false)}>{t('common.cancel')}</button>
                    <button type="submit" className="btn btn-primary btn-sm">{t('common.add')}</button>
                  </div>
                </form>
              )}
            </div>
          )}

          {product.colors.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('products.no_colors')}</div>
          ) : (
            <div className="colors-grid">
              {product.colors.map((color) => (
                <div key={color.id} className="color-card card">
                  <div className="color-card__header">
                    {color.hex_code && (
                      <span className="color-swatch" style={{ backgroundColor: color.hex_code }} />
                    )}
                    <strong>{color.color_name}</strong>
                    <span className={`badge ${color.is_active ? 'badge-success' : 'badge-danger'}`}>
                      {color.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                    {canWrite && (
                      <button className="btn btn-sm btn-danger" onClick={() => handleDeleteColor(color.id)} title={t('common.delete')} style={{ marginLeft: 'auto', padding: '2px 8px' }}>✕</button>
                    )}
                  </div>

                  {/* Images */}
                  <div className="color-images">
                    {color.images.map((img) => (
                      <div key={img.id} className={`color-image ${img.is_primary ? 'color-image--primary' : ''}`}>
                        <img src={img.image_url} alt={color.color_name} />
                        {canWrite && (
                          <div className="color-image__actions">
                            {!img.is_primary && (
                              <button className="btn btn-sm btn-secondary" onClick={() => handleSetPrimary(img.id)}>★</button>
                            )}
                            <button className="btn btn-sm btn-danger" onClick={() => handleDeleteImage(img.id)}>✕</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {canWrite && (
                      <button
                        className="color-image color-image--add"
                        onClick={() => { setUploadColorId(color.id); fileInputRef.current?.click(); }}
                      >
                        + {t('products.add_image')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleImageUpload} />
        </div>
      )}

      {/* === VARIANTS TAB === */}
      {activeTab === 'variants' && (
        <div className="tab-content">
          {canWrite && (
            <div style={{ marginBottom: 'var(--spacing-lg)' }}>
              {!showVariantForm ? (
                <button className="btn btn-primary" onClick={() => setShowVariantForm(true)}>+ {t('products.add_variants')}</button>
              ) : (
                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
                    <h3 style={{ margin: 0 }}>{t('products.add_variants')}</h3>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button className={`btn btn-sm ${generatorMode ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setGeneratorMode(true)}>⚡ {t('products.smart_generator')}</button>
                      <button className={`btn btn-sm ${!generatorMode ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setGeneratorMode(false)}>📝 {t('products.single_variant')}</button>
                    </div>
                  </div>

                  {generatorMode ? (
                    /* SMART GENERATOR MODE */
                    <div>
                      {product.colors.length === 0 ? (
                        <p style={{ color: 'var(--color-text-danger)' }}>{t('products.add_colors_first')}</p>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
                          <div className="form-group">
                            <label className="form-label">{t('products.select_colors_generate')}</label>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                              {product.colors.map(c => (
                                <button
                                  key={c.id}
                                  type="button"
                                  onClick={() => handleToggleGenColor(c.id)}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 6,
                                    padding: '6px 12px', borderRadius: 20,
                                    border: genSelectedColors.includes(c.id) ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                                    backgroundColor: genSelectedColors.includes(c.id) ? 'var(--color-primary-light)' : 'var(--color-surface)',
                                    cursor: 'pointer', transition: 'all 0.2s ease'
                                  }}
                                >
                                  {c.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: c.hex_code, width: 16, height: 16 }} />}
                                  <span style={{ fontWeight: genSelectedColors.includes(c.id) ? 600 : 400 }}>{c.color_name}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                          
                          <div className="form-row" style={{ alignItems: 'flex-end' }}>
                            <div className="form-group" style={{ flex: 1 }}>
                              <label className="form-label">{t('products.start_size')}</label>
                              <input className="form-input" type="number" value={genSizeStart} onChange={e => setGenSizeStart(e.target.value)} placeholder="e.g. 38" />
                            </div>
                            <div className="form-group" style={{ flex: 1 }}>
                              <label className="form-label">{t('products.end_size')}</label>
                              <input className="form-input" type="number" value={genSizeEnd} onChange={e => setGenSizeEnd(e.target.value)} placeholder="e.g. 45" />
                            </div>
                            <div className="form-group">
                              <button className="btn btn-secondary" onClick={handleGeneratePreview}>{t('products.generate_preview')}</button>
                            </div>
                          </div>

                          {genPreview.length > 0 && (
                            <div style={{ marginTop: 'var(--spacing-md)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)' }}>
                              <h4>{t('products.preview_generating')} ({genPreview.length} {t('products.variants')})</h4>
                              <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', marginBottom: 8 }}>{t('products.preview_description')}</p>
                              <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                                <table className="table" style={{ margin: 0 }}>
                                  <thead style={{ position: 'sticky', top: 0, backgroundColor: 'var(--color-surface)', zIndex: 1, borderBottom: '2px solid var(--color-border)' }}>
                                    <tr>
                                      <th>{t('products.colors')}</th><th>EU</th><th>US ({t('common.optional')})</th><th>UK ({t('common.optional')})</th><th>CM ({t('common.optional')})</th><th></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {genPreview.map((p) => {
                                      const c = product.colors.find(col => col.id === p.product_color_id);
                                      return (
                                        <tr key={p.tempId}>
                                          <td style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            {c?.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: c.hex_code }} />}
                                            {c?.color_name}
                                          </td>
                                          <td style={{ fontWeight: 600 }}>{p.size_eu}</td>
                                          <td><input className="form-input" style={{ padding: '4px 8px' }} value={p.size_us} onChange={e => updatePreviewRow(p.tempId, 'size_us', e.target.value)} placeholder="e.g. 9" /></td>
                                          <td><input className="form-input" style={{ padding: '4px 8px' }} value={p.size_uk} onChange={e => updatePreviewRow(p.tempId, 'size_uk', e.target.value)} placeholder="e.g. 8" /></td>
                                          <td><input className="form-input" type="number" step="0.1" style={{ padding: '4px 8px' }} value={p.size_cm} onChange={e => updatePreviewRow(p.tempId, 'size_cm', e.target.value)} placeholder="e.g. 27.0" /></td>
                                          <td><button className="btn btn-sm btn-danger" title={t('products.remove')} onClick={() => deletePreviewRow(p.tempId)}>✕</button></td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </div>
                              <div className="form-actions" style={{ marginTop: 'var(--spacing-md)' }}>
                                <button type="button" className="btn btn-secondary" onClick={() => { setGenPreview([]); setShowVariantForm(false); }}>{t('common.cancel')}</button>
                                <button type="button" className="btn btn-primary" onClick={handleSaveGeneratedVariants}>{t('products.save_all_variants')}</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    /* SINGLE VARIANT FORM */
                    <form onSubmit={handleAddVariant} className="inline-form">
                      <div className="form-row">
                        <div className="form-group">
                          <label className="form-label">{t('products.colors')} *</label>
                          <SearchableSelect
                            required
                            options={[
                              { value: '', label: t('products.select_color') },
                              ...product.colors.map((c) => ({ value: c.id, label: c.color_name }))
                            ]}
                            value={variantForm.product_color_id}
                            onChange={(e) => setVariantForm({ ...variantForm, product_color_id: e.target.value })}
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">{t('products.eu_size')} *</label>
                          <input className="form-input" required value={variantForm.size_eu}
                            onChange={(e) => setVariantForm({ ...variantForm, size_eu: e.target.value })}
                            placeholder="42" />
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="form-group">
                          <label className="form-label">{t('products.us_size')}</label>
                          <input className="form-input" value={variantForm.size_us}
                            onChange={(e) => setVariantForm({ ...variantForm, size_us: e.target.value })} placeholder="9" />
                        </div>
                        <div className="form-group">
                          <label className="form-label">{t('products.uk_size')}</label>
                          <input className="form-input" value={variantForm.size_uk}
                            onChange={(e) => setVariantForm({ ...variantForm, size_uk: e.target.value })} placeholder="8" />
                        </div>
                        <div className="form-group">
                          <label className="form-label">CM</label>
                          <input className="form-input" type="number" step="0.1" value={variantForm.size_cm}
                            onChange={(e) => setVariantForm({ ...variantForm, size_cm: e.target.value })} />
                        </div>
                      </div>
                      <div className="form-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowVariantForm(false)}>{t('common.cancel')}</button>
                        <button type="submit" className="btn btn-primary btn-sm">{t('products.add_variant')}</button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </div>
          )}

          {product.variants.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('products.no_variants')}. {t('products.add_color_first')}</div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('products.sku')}</th>
                    <th>{t('products.colors')}</th>
                    <th>EU</th>
                    <th>US</th>
                    <th>UK</th>
                    <th>CM</th>
                    <th>{t('common.status')}</th>
                    {canWrite && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map((v) => {
                    const color = product.colors.find((c) => c.id === v.product_color_id);
                    const isEditing = editingVariantId === v.id;
                    
                    if (isEditing) {
                      return (
                        <tr key={v.id}>
                          <td><strong>{v.sku}</strong></td>
                          <td>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {color?.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: color.hex_code }} />}
                              {color?.color_name || '—'}
                            </span>
                          </td>
                          <td>{v.size_eu}</td>
                          <td><input className="form-input" style={{ padding: '4px 8px', maxWidth: 60 }} value={editVariantForm.size_us} onChange={e => setEditVariantForm({...editVariantForm, size_us: e.target.value})} placeholder="US" /></td>
                          <td><input className="form-input" style={{ padding: '4px 8px', maxWidth: 60 }} value={editVariantForm.size_uk} onChange={e => setEditVariantForm({...editVariantForm, size_uk: e.target.value})} placeholder="UK" /></td>
                          <td><input className="form-input" type="number" step="0.1" style={{ padding: '4px 8px', maxWidth: 70 }} value={editVariantForm.size_cm} onChange={e => setEditVariantForm({...editVariantForm, size_cm: e.target.value})} placeholder="27.0" /></td>
                          <td>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}>
                              <input type="checkbox" checked={editVariantForm.is_active} onChange={e => setEditVariantForm({...editVariantForm, is_active: e.target.checked})} />
                              {editVariantForm.is_active ? t('common.active') : t('common.inactive')}
                            </label>
                          </td>
                          {canWrite && (
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <button className="btn btn-sm btn-success" onClick={() => handleSaveVariantEdit(v.id)} title={t('common.save')}>💾</button>
                              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 4 }} onClick={handleCancelEditVariant} title={t('common.cancel')}>✕</button>
                            </td>
                          )}
                        </tr>
                      );
                    }

                    return (
                      <tr key={v.id}>
                        <td><strong>{v.sku}</strong></td>
                        <td>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {color?.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: color.hex_code }} />}
                            {color?.color_name || '—'}
                          </span>
                        </td>
                        <td>{v.size_eu}</td>
                        <td>{v.size_us || '—'}</td>
                        <td>{v.size_uk || '—'}</td>
                        <td>{v.size_cm != null ? `${v.size_cm}` : '—'}</td>
                        <td>
                          <span className={`badge ${v.is_active ? 'badge-success' : 'badge-danger'}`}>
                            {v.is_active ? t('common.active') : t('common.inactive')}
                          </span>
                        </td>
                        {canWrite && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn btn-sm btn-secondary" onClick={() => handleEditVariantClick(v)} title={t('common.edit')}>✏️</button>
                            <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => handleDeleteVariant(v.id)} title={t('common.delete')}>✕</button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* === STORE PRICES TAB === */}
      {activeTab === 'prices' && (
        <div className="tab-content">
          <div className="price-defaults card" style={{ marginBottom: 'var(--spacing-lg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
              <h3 style={{ margin: 0 }}>{t('products.default_prices')}</h3>
              {canWrite && <button className="btn btn-sm btn-secondary" onClick={handleEditProductClick}>✏️ {t('common.edit')}</button>}
            </div>
            <p style={{ color: 'var(--color-text-secondary)' }}>
              {t('products.cost')}: <strong>{product.net_price ?? '—'} {t('common.currency')}</strong> &nbsp;|&nbsp;
              {t('products.sell')}: <strong>{product.default_selling_price ?? '—'} {t('common.currency')}</strong> &nbsp;|&nbsp;
              {t('products.min')}: <strong>{product.min_selling_price ?? '—'}</strong> &nbsp;|&nbsp;
              {t('products.max')}: <strong>{product.max_selling_price ?? '—'}</strong>
            </p>
          </div>

          {canWrite && (
            <div style={{ marginBottom: 'var(--spacing-lg)' }}>
              {!showPriceForm ? (
                <button className="btn btn-primary" onClick={() => setShowPriceForm(true)}>+ {t('products.set_store_price')}</button>
              ) : (
                <form onSubmit={handleSetPrice} className="inline-form card">
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">{t('stores.title')} *</label>
                      <SearchableSelect
                        required
                        options={[
                          { value: '', label: t('products.select_store') },
                          ...stores.map((s) => ({ value: s.id, label: s.name }))
                        ]}
                        value={priceForm.store_id}
                        onChange={(e) => setPriceForm({ ...priceForm, store_id: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('products.selling_price')} *</label>
                      <input className="form-input" type="number" step="0.01" required value={priceForm.selling_price}
                        onChange={(e) => setPriceForm({ ...priceForm, selling_price: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">{t('products.min_price')}</label>
                      <input className="form-input" type="number" step="0.01" value={priceForm.min_selling_price}
                        onChange={(e) => setPriceForm({ ...priceForm, min_selling_price: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('products.max_price')}</label>
                      <input className="form-input" type="number" step="0.01" value={priceForm.max_selling_price}
                        onChange={(e) => setPriceForm({ ...priceForm, max_selling_price: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPriceForm(false)}>{t('common.cancel')}</button>
                    <button type="submit" className="btn btn-primary btn-sm">{t('common.save')}</button>
                  </div>
                </form>
              )}
            </div>
          )}

          {product.store_prices?.length > 0 ? (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr><th>{t('stores.title')}</th><th>{t('products.selling_price')}</th><th>{t('products.min')}</th><th>{t('products.max')}</th>{canWrite && <th>{t('common.actions')}</th>}</tr>
                </thead>
                <tbody>
                  {product.store_prices.map((sp) => (
                    <tr key={sp.id}>
                      <td><strong>{sp.store_name}</strong></td>
                      <td>{sp.selling_price} {t('common.currency')}</td>
                      <td>{sp.min_selling_price ?? t('products.default_price')}</td>
                      <td>{sp.max_selling_price ?? t('products.default_price')}</td>
                      {canWrite && (
                        <td>
                          <button className="btn btn-sm btn-danger" onClick={() => handleDeletePrice(sp.store_id)}>{t('products.remove')}</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
              {t('products.no_store_prices')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
