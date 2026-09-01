import { useState, useEffect, Fragment, lazy, Suspense } from 'react';
import { inventoryAPI, storesAPI, productsAPI, productCategoriesAPI, sizeScalesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { formatSize, formatColor, compareSize, localizedName, sizeValueLabel } from '../../utils/variantFormat';
import SearchableSelect from '../../components/common/SearchableSelect';
import ClickableImage from '../../components/common/ClickableImage';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

const PrintLabelsModal = lazy(() => import('../../components/barcode/PrintLabelsModal'));

// `docx` is ~400 kB and only needed when the user actually exports. Imported
// dynamically so it is not part of the bundle every page load pays for.
const loadDocx = () => import('docx');

// --- Tree View Components ---

const InventoryTreeSizeRow = ({ sizeRow }) => {
  const { t, locale } = useTranslation();
  return (
  <tr className="tree-row size-row" style={{ backgroundColor: 'transparent' }}>
    <td style={{ paddingInlineStart: '5.5rem', color: 'var(--color-text-secondary)' }}>{formatSize(sizeRow, locale)}</td>
    <td style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{sizeRow.sku}</td>
    <td>{sizeRow.store_name}</td>
    <td>{parseFloat(sizeRow.avg_cost).toFixed(2)} {t('common.currency')}</td>
    <td><strong>{sizeRow.quantity}</strong></td>
    <td></td>
  </tr>
  );
};

const InventoryTreeColorRow = ({ color, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  
  return (
    <Fragment>
      <tr className="tree-row color-row" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', backgroundColor: 'var(--color-row-alt)' }}>
        <td style={{ paddingInlineStart: '3rem' }}>
          <button className="btn-icon" style={{ padding: '0 8px', marginRight: 12, background: 'none', border:'none', color: 'inherit', cursor: 'pointer' }}>
            {expanded ? '▼' : '▶'}
          </button>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {color.hex && <span className="color-swatch-sm" style={{ backgroundColor: color.hex, width: 14, height: 14, borderRadius: '50%', display: 'inline-block', border: '1px solid var(--color-subtle-border)' }} />}
            <strong>{color.name}</strong>
          </span>
        </td>
        <td></td>
        <td></td>
        <td></td>
        <td style={{ color: 'var(--color-primary-light)' }}><strong>{color.total_quantity}</strong></td>
        <td></td>
      </tr>
      {expanded && color.sizes.map((sizeRow, idx) => (
        <InventoryTreeSizeRow key={idx} sizeRow={sizeRow} />
      ))}
    </Fragment>
  );
};

const InventoryTreeProductRow = ({ product, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  
  return (
    <Fragment>
      <tr className="tree-row product-row" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', backgroundColor: 'var(--color-row-alt-strong)' }}>
        <td style={{ fontSize: '1.05em' }}>
          <button className="btn btn-sm btn-secondary" style={{ padding: '2px 8px', marginRight: 12, background: 'var(--color-row-alt-strong)', border: 'none' }}>
            {expanded ? '▼' : '▶'}
          </button>
          <strong>{product.code}</strong> — {product.name}
          {product.brand && <span className="badge badge-neutral" style={{ marginLeft: 8 }}>{product.brand}</span>}
        </td>
        <td></td>
        <td></td>
        <td></td>
        <td style={{ fontSize: '1.1em', color: 'var(--color-success)' }}><strong>{product.total_quantity}</strong></td>
        <td>
          {product.image ? (
            <ClickableImage
              src={product.image}
              thumbSrc={product.imageThumb}
              alt="product"
              title={product.name}
              width={44}
              height={44}
              style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }}
            />
          ) : (
            <div style={{ width: 44, height: 44, background: 'var(--color-surface-hover)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>—</div>
          )}
        </td>
      </tr>
      {expanded && Array.from(product.colors.values()).map(color => (
        <InventoryTreeColorRow key={color.name} color={color} />
      ))}
    </Fragment>
  );
};

const buildImageUrlCandidates = (imageUrl) => {
  if (!imageUrl) return [];

  const raw = String(imageUrl).trim();
  if (!raw) return [];

  const normalized = raw.replace(/\\/g, '/');
  const candidates = new Set([normalized]);

  if (normalized.startsWith('http://')) candidates.add(`https://${normalized.slice('http://'.length)}`);
  if (normalized.startsWith('https://')) candidates.add(`http://${normalized.slice('https://'.length)}`);

  return Array.from(candidates);
};

const loadImageSize = (blob) => new Promise((resolve, reject) => {
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const size = { width: img.naturalWidth || 1, height: img.naturalHeight || 1 };
    URL.revokeObjectURL(objectUrl);
    resolve(size);
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    reject(new Error('Unable to load image'));
  };
  img.src = objectUrl;
});

/**
 * Run async tasks with a bounded number in flight.
 *
 * The export previously fired every image request at once — for 200 products that is
 * ~800 simultaneous proxied downloads, which blew through the server's rate limit and
 * spiked its memory. Four at a time keeps it well inside both.
 */
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  });

  await Promise.all(runners);
  return results;
};

const fetchImageForDocx = async (imageUrl, maxWidth = 420, maxHeight = 260) => {
  const candidates = buildImageUrlCandidates(imageUrl);
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    try {
      const response = await inventoryAPI.exportImage(candidate);
      const sourceBlob = response.data;
      const natural = await loadImageSize(sourceBlob);
      const ratio = Math.min(maxWidth / natural.width, maxHeight / natural.height, 1);
      const width = Math.max(80, Math.round(natural.width * ratio));
      const height = Math.max(80, Math.round(natural.height * ratio));

      const objectUrl = URL.createObjectURL(sourceBlob);
      const img = new Image();
      try {
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = objectUrl;
        });

        // Draw at the FINAL display size, not the source's natural size. The old code
        // allocated a full-resolution canvas (a 4000×3000 photo = ~48 MB of RGBA) and
        // then encoded it as PNG, which is far larger than the JPEG source — so the
        // .docx ended up bigger than the originals it was built from.
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        // JPEG has no alpha channel: without an explicit white fill, transparent
        // product cut-outs composite onto black instead of the page background.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const jpegBlob = await new Promise((resolve, reject) => {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('jpeg conversion failed'))),
            'image/jpeg',
            0.82
          );
        });

        const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
        return { data: bytes, width, height };
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      // Try next candidate URL.
    }
  }

  throw new Error('Image fetch failed');
};

// --- Main Page Component ---

export default function InventoryPage() {
  const [items, setItems] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    store_id: '', status: 'in_stock', search: '', category_id: '',
    size_min: '', size_max: '',
    // Exact sizes, for a category whose sizes are words. A numeric range cannot
    // express 'Kids' — and used to make every such row disappear without saying so.
    size_values: [],
  });
  const [categories, setCategories] = useState([]);
  // scale id -> its values, so switching category needs no extra request.
  const [valuesByScale, setValuesByScale] = useState({});
  const [viewMode, setViewMode] = useState('summary'); // 'summary' or 'items'
  const [exportingWord, setExportingWord] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const { filterStores } = useAuth();
  const { t, locale } = useTranslation();
  const [treeData, setTreeData] = useState([]);

  useEffect(() => { fetchStores(); fetchCatalogue(); }, []);
  useEffect(() => { fetchData(); }, [viewMode, filters.store_id, filters.status, filters.category_id, filters.size_values]);

  const fetchStores = async () => {
    try {
      const { data } = await storesAPI.list();
      setStores(filterStores(data.data));
    } catch { /* ignore */ }
  };

  const fetchCatalogue = async () => {
    try {
      const [cats, scales] = await Promise.all([
        productCategoriesAPI.list({ is_active: true }),
        sizeScalesAPI.list({ include_values: true }),
      ]);
      setCategories(cats.data.data || []);
      setValuesByScale(Object.fromEntries((scales.data.data || []).map((sc) => [sc.id, sc.values || []])));
    } catch {
      // The page still works without it — the category picker simply does not appear.
    }
  };

  /**
   * Switching category clears the size filter.
   *
   * A size only means something inside its own list: 'Kids' is not a belt length and
   * '95' is not a sock. Carrying the old value over would filter to nothing and look
   * like missing stock.
   */
  const changeCategory = (category_id) =>
    setFilters((f) => ({ ...f, category_id, size_min: '', size_max: '', size_values: [] }));

  const toggleSizeValue = (value) =>
    setFilters((f) => ({
      ...f,
      size_values: f.size_values.includes(value)
        ? f.size_values.filter((v) => v !== value)
        : [...f.size_values, value],
    }));

  const fetchData = async () => {
    try {
      setLoading(true);
      const params = buildQueryParams({ includeStatus: viewMode === 'items' });

      if (viewMode === 'summary') {
        const { data } = await inventoryAPI.summary(params);
        setItems(data.data);
        buildTree(data.data);
      } else {
        const { data } = await inventoryAPI.list(params);
        setItems(data.data);
        setTreeData([]);
      }
    } catch { toast.error(t('inventory.no_inventory')); }
    finally { setLoading(false); }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    fetchData();
  };

  const selectedCategory = categories.find((c) => c.id === filters.category_id) || null;
  // With no category chosen the catalogue may hold any kind of size, so the range
  // stays available — it is the only control that makes sense across all of them.
  const sizeIsNumeric = !selectedCategory || selectedCategory.scale_is_numeric;
  const sizeUnit = selectedCategory ? (selectedCategory.display_prefix || selectedCategory.display_suffix || '') : '';
  const sizeAxisLabel = sizeUnit
    ? `${t('products.size_generic')} (${sizeUnit})`
    : t('products.size_generic');

  const buildQueryParams = ({ includeStatus = true } = {}) => {
    const params = {};
    if (filters.store_id) params.store_id = filters.store_id;
    if (includeStatus && filters.status) params.status = filters.status;
    if (filters.search) params.search = filters.search;
    if (filters.category_id) params.category_id = filters.category_id;
    if (filters.size_min) params.size_min = filters.size_min;
    if (filters.size_max) params.size_max = filters.size_max;
    if (filters.size_values.length) params.size_values = filters.size_values.join(',');
    return params;
  };

  const formatMoney = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return `${num.toLocaleString('ar-EG')} ${t('common.currency')}`;
  };

  const handleExportWord = async () => {
    try {
      setExportingWord(true);

      const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } = await loadDocx();

      const { data } = await inventoryAPI.summary(buildQueryParams({ includeStatus: false }));
      const rows = data?.data || [];
      if (!rows.length) {
        toast.error(t('inventory.no_inventory'));
        return;
      }

      const productMap = new Map();
      for (const row of rows) {
        if (!productMap.has(row.product_id)) {
          productMap.set(row.product_id, {
            id: row.product_id,
            code: row.product_code,
            name: row.product_name,
            brand: row.brand,
            rows: [],
            imageUrls: new Set(row.product_image ? [row.product_image] : []),
          });
        }
        productMap.get(row.product_id).rows.push(row);
      }

      const products = Array.from(productMap.values());

      // Colour lookups run a few at a time rather than strictly one-after-another,
      // which is what made this loop the slowest part of the export.
      await mapWithConcurrency(products, 4, async (product) => {
        try {
          const { data: colorsRes } = await productsAPI.listColors(product.id);
          const colors = colorsRes?.data || [];
          colors.forEach((color) => {
            (color.images || []).forEach((img) => {
              // Prefer the thumbnail: the export renders these at ~420px, so the
              // full-size original is wasted bandwidth on both ends.
              const url = img.thumb_url || img.image_url;
              if (url) product.imageUrls.add(url);
            });
          });
        } catch {
          // Best effort: keep export running even when a product images call fails.
        }
      });

      const sections = [];
      for (const product of products) {
        const productRows = product.rows;
        const first = productRows[0] || {};

        const imageCandidates = Array.from(product.imageUrls).slice(0, 4);
        const imageResults = await mapWithConcurrency(
          imageCandidates, 4, (url) => fetchImageForDocx(url)
        );

        const imageRuns = imageResults
          .filter((r) => r.status === 'fulfilled' && r.value)
          .map((r) => new ImageRun({
            type: 'jpg',
            data: r.value.data,
            transformation: { width: r.value.width, height: r.value.height },
          }));

        const sizesByColor = new Map();
        let totalQty = 0;
        for (const row of productRows) {
          const colorKey = row.color_name || 'N/A';
          if (!sizesByColor.has(colorKey)) sizesByColor.set(colorKey, new Map());
          const sizeMap = sizesByColor.get(colorKey);
          const sizeKey = String(row.size_eu);
          const qty = Number(row.quantity) || 0;
          const prev = sizeMap.get(sizeKey);
          sizeMap.set(sizeKey, { qty: (prev ? prev.qty : 0) + qty, row });
          totalQty += qty;
        }

        const netPrice = first.net_price;

        const children = [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            children: [new TextRun(`${product.code || ''} - ${product.name || 'Product'}`)],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 240 },
            children: [
              new TextRun({ text: `${t('products.brand')}: `, bold: true }),
              new TextRun(product.brand || '—'),
              new TextRun({ text: `   |   سعر الشراء: `, bold: true }),
              new TextRun(formatMoney(netPrice)),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 320 },
            children: [
              new TextRun({ text: `الكمية: `, bold: true }),
              new TextRun(String(totalQty)),
            ],
          }),
        ];

        if (imageRuns.length > 0) {
          imageRuns.forEach((run) => {
            children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 180 }, children: [run] }));
          });
        } else {
          children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 180 }, text: 'لا توجد صورة متاحة' }));
        }

        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 180, after: 120 },
            text: 'المقاسات / الكمية',
          })
        );

        Array.from(sizesByColor.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .forEach(([colorName, sizeMap]) => {
            const sizeLine = Array.from(sizeMap.entries())
              .sort((a, b) => compareSize(a[1].row, b[1].row))
              .map(([, v]) => `${formatSize(v.row, locale) || v.row.size_eu} (${v.qty})`)
              .join('    ');

            children.push(
              new Paragraph({ children: [new TextRun({ text: `اللون: ${colorName}`, bold: true })] }),
              new Paragraph({ spacing: { after: 80 }, text: sizeLine || '—' })
            );
          });

        sections.push({ children });
      }

      const doc = new Document({ sections });
      const blob = await Packer.toBlob(doc);
      const filename = `inventory-products-${new Date().toISOString().slice(0, 10)}.docx`;
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);

      toast.success(`${t('common.download')} ${products.length} ${t('common.items')}`);
    } catch (error) {
      toast.error(error?.response?.data?.message || t('common.error'));
    } finally {
      setExportingWord(false);
    }
  };

  const buildTree = (rawData) => {
    const tree = [];
    const prodMap = new Map();

    for (const row of rawData) {
      if (!prodMap.has(row.product_id)) {
        prodMap.set(row.product_id, {
          id: row.product_id,
          code: row.product_code,
          name: row.product_name,
          brand: row.brand,
          image: row.product_image,
          imageThumb: row.product_image_thumb,
          total_quantity: 0,
          colors: new Map()
        });
        tree.push(prodMap.get(row.product_id));
      }
      const prodNode = prodMap.get(row.product_id);
      prodNode.total_quantity += Number(row.quantity);

      const colorKey = `${row.color_name}-${row.hex_code}`;
      if (!prodNode.colors.has(colorKey)) {
        prodNode.colors.set(colorKey, {
          name: row.color_name,
          hex: row.hex_code,
          total_quantity: 0,
          sizes: []
        });
      }
      const colorNode = prodNode.colors.get(colorKey);
      colorNode.total_quantity += Number(row.quantity);
      colorNode.sizes.push(row);
    }
    setTreeData(tree);
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('inventory.title')}</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
          <button
            className="btn btn-secondary"
            onClick={() => setShowLabels(true)}
            // Nothing on screen means nothing to label; opening the dialog would only
            // show an empty list.
            disabled={loading || items.length === 0}
            data-testid="inventory-print-labels"
          >
            🏷 {t('barcode.print_labels')}
          </button>
          <button className="btn btn-secondary" onClick={handleExportWord} disabled={exportingWord}>
            {exportingWord ? 'جاري التحميل...' : 'تصدير وورد'}
          </button>
          <button className={`btn ${viewMode === 'summary' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('summary')}>{t('inventory.summary')}</button>
          <button className={`btn ${viewMode === 'items' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('items')}>{t('inventory.total_items')}</button>
        </div>
      </div>

      {/* Advanced Filters */}
      <div className="card filters-panel">
        <form onSubmit={handleSearch} className="filters-grid" style={{ alignItems: 'flex-end' }}>
          
          <div className="form-group">
            <label className="form-label">{t('common.search')}</label>
            <input className="form-input" placeholder={t('inventory.search_placeholder')} value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.store')}</label>
            <SearchableSelect
              options={[
                { value: '', label: t('stores.all_stores') },
                ...stores.map((s) => ({ value: s.id, label: s.name }))
              ]}
              value={filters.store_id}
              onChange={(e) => setFilters({ ...filters, store_id: e.target.value })}
            />
          </div>

          <div className="form-group" data-testid="inventory-category">
            <label className="form-label">{t('products.category')}</label>
            <SearchableSelect
              options={[
                { value: '', label: t('common.all') },
                ...categories.map((c) => ({ value: c.id, label: localizedName(c, locale) })),
              ]}
              value={filters.category_id}
              onChange={(e) => changeCategory(e.target.value)}
            />
          </div>

          {/* The size control follows the category's size list. A number range is
              offered only for a list that IS numbers; anything else gets its own
              values as chips, because a range cannot express them. */}
          {selectedCategory && !selectedCategory.has_sizes ? (
            <div className="form-group" data-testid="inventory-size-none">
              <label className="form-label">{t('products.size_generic')}</label>
              <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', paddingTop: '0.6rem' }}>
                {t('inventory.category_no_sizes')}
              </div>
            </div>
          ) : sizeIsNumeric ? (
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', flexDirection: 'column' }}>
              <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="form-label">{sizeAxisLabel} Min</label>
                  <input type="number" step="0.5" className="form-input" placeholder="38" value={filters.size_min}
                    data-testid="inventory-size-min"
                    onChange={(e) => setFilters({ ...filters, size_min: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="form-label">{sizeAxisLabel} Max</label>
                  <input type="number" step="0.5" className="form-input" placeholder="46" value={filters.size_max}
                    data-testid="inventory-size-max"
                    onChange={(e) => setFilters({ ...filters, size_max: e.target.value })} />
                </div>
              </div>
              {/* Said out loud, because it used to happen silently. */}
              {!selectedCategory && (filters.size_min || filters.size_max) && (
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8em' }} data-testid="inventory-size-hint">
                  {t('inventory.numeric_only_hint')}
                </div>
              )}
            </div>
          ) : (
            <div className="form-group" data-testid="inventory-size-values">
              <label className="form-label">{sizeAxisLabel}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {(valuesByScale[selectedCategory.size_scale_id] || []).map((v) => {
                  const on = filters.size_values.includes(v.value);
                  return (
                    <button key={v.id || v.value} type="button"
                      className={`btn ${on ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ padding: '0.25rem 0.6rem', fontSize: '0.85em' }}
                      onClick={() => toggleSizeValue(v.value)}>
                      {sizeValueLabel(v, locale)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {viewMode === 'items' && (
            <div className="form-group">
              <label className="form-label">{t('inventory.status')}</label>
              <SearchableSelect
                options={[
                  { value: '', label: t('common.all') },
                  { value: 'in_stock', label: t('inventory.in_stock') },
                  { value: 'sold', label: t('inventory.sold') },
                  { value: 'damaged', label: t('inventory.damaged') },
                  { value: 'in_transfer', label: t('inventory.in_transfer') }
                ]}
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              />
            </div>
          )}
          
          <div className="form-group">
            <button type="submit" className="btn btn-primary" style={{ paddingLeft: 'var(--spacing-xl)', paddingRight: 'var(--spacing-xl)' }}>{t('common.search')}</button>
          </div>
        </form>
      </div>

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {viewMode === 'summary' ? (
                  <>
                    <th style={{ width: '35%' }}>{t('inventory.product')} ➔ {t('inventory.color')} ➔ {t('inventory.size')}</th>
                    <th>{t('inventory.sku')}</th>
                    <th>{t('inventory.store')}</th>
                    <th>{t('inventory.avg_cost')}</th>
                    <th>{t('inventory.quantity')}</th>
                    <th></th>
                  </>
                ) : (
                  <>
                    <th>{t('inventory.sku')}</th><th>{t('inventory.product')}</th><th>{t('inventory.color')}</th><th>{t('inventory.size')}</th><th>{t('inventory.store')}</th><th>{t('inventory.avg_cost')}</th><th>{t('common.type')}</th><th>{t('inventory.status')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={viewMode === 'summary' ? 6 : 8} style={{ textAlign: 'center', padding: 'var(--spacing-2xl)', color: 'var(--color-text-muted)' }}>
                  <div style={{ fontSize: '2rem', marginBottom: 'var(--spacing-sm)' }}>📦</div>
                  {t('inventory.no_inventory')}
                </td></tr>
              ) : viewMode === 'summary' ? (
                treeData.map((product) => (
                  <InventoryTreeProductRow key={product.id} product={product} />
                ))
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="product-row">
                    <td><strong>{item.sku}</strong></td>
                    <td>{item.product_code} — {item.product_name}</td>
                    <td>{item.color_name}</td>
                    <td>{formatSize(item, locale)}</td>
                    <td>{item.store_name}</td>
                    <td>{parseFloat(item.cost).toFixed(2)} {t('common.currency')}</td>
                    <td><span className={`badge ${item.source === 'purchase' ? 'badge-info' : 'badge-neutral'}`}>{item.source}</span></td>
                    <td><span className={`badge ${item.status === 'in_stock' ? 'badge-success' : item.status === 'sold' ? 'badge-neutral' : 'badge-danger'}`}>{item.status}</span></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      {showLabels && (
        <Suspense fallback={null}>
          <PrintLabelsModal
            variantIds={[...new Set((items || []).map((i) => i.variant_id).filter(Boolean))]}
            storeId={filters.store_id || undefined}
            title={t('inventory.title')}
            onClose={() => setShowLabels(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
