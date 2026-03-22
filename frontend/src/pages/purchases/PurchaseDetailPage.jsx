import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { purchasesAPI, productsAPI, storesAPI, suppliersAPI, boxTemplatesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import ImageViewerModal from '../../components/common/ImageViewerModal';
import '../products/Products.css';

export default function PurchaseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('purchases', 'write');

  const [invoice, setInvoice] = useState(null);
  const [products, setProducts] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('boxes');
  const fileInputRef = useRef(null);

  // Box form
  const [showBoxForm, setShowBoxForm] = useState(false);
  const [boxForm, setBoxForm] = useState({
    product_id: '', product_color_id: '', cost_per_item: '', total_items: '', destination_store_id: '', notes: '',
  });
  const [colorOptions, setColorOptions] = useState([]);

  // Box items form
  const [editingBoxId, setEditingBoxId] = useState(null);
  const [boxItems, setBoxItems] = useState([{ size_eu: '', size_us: '', size_uk: '', size_cm: '', quantity: '' }]);

  // Payment form
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentForm, setPaymentForm] = useState({
    total_amount: '', payment_method: 'cash', payment_date: new Date().toISOString().split('T')[0], reference_no: '', notes: '',
  });

  // Edit Invoice Form
  const [showEditInvoice, setShowEditInvoice] = useState(false);
  const [editInvoiceForm, setEditInvoiceForm] = useState({
    total_amount: '', discount_amount: '', invoice_date: '', notes: ''
  });

  // View Image Modal
  const [viewerImage, setViewerImage] = useState(null);

  // Box Templates
  const [templates, setTemplates] = useState([]);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState('');

  useEffect(() => { fetchAll(); }, [id]);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [inv, prods, strs, tmpls] = await Promise.all([
        purchasesAPI.getInvoice(id),
        productsAPI.list(),
        storesAPI.list(),
        boxTemplatesAPI.list(),
      ]);
      setInvoice(inv.data.data);
      setProducts(prods.data.data);
      setStores(strs.data.data);
      setTemplates(tmpls.data.data);
    } catch {
      toast.error('Invoice not found');
      navigate('/purchases');
    } finally { setLoading(false); }
  };

  // --- Apply template: convert template items → colorGroups + auto-map colors ---
  const applyTemplate = (templateId, currentColorOptions) => {
    const tmpl = templates.find(t => t.id === templateId);
    if (!tmpl) return;

    // Group template items by color_label
    const labelMap = {};
    tmpl.items.forEach(item => {
      const label = item.color_label || '__default__';
      if (!labelMap[label]) labelMap[label] = [];
      labelMap[label].push({ size_eu: item.size, size_us: '', size_uk: '', size_cm: '', quantity: String(item.quantity) });
    });

    // Smart auto-map: try to match color_label to a product color by name
    const groups = Object.entries(labelMap).map(([label, sizes]) => {
      let color_id = '';
      if (label !== '__default__' && currentColorOptions.length > 0) {
        const match = currentColorOptions.find(c =>
          c.color_name.toLowerCase() === label.toLowerCase()
        );
        if (match) color_id = match.id;
      }
      return { color_id, sizes };
    });

    setColorGroups(groups);

    // Auto-calc total_items
    const total = tmpl.items.reduce((sum, i) => sum + i.quantity, 0);
    setBoxForm(prev => ({ ...prev, total_items: String(total) }));

    toast.success(`Template "${tmpl.name}" applied (${total} items)`);
  };

  // --- Save current colorGroups as a new template ---
  const handleSaveAsTemplate = async () => {
    if (!saveTemplateName.trim()) { toast.error('Please enter a template name'); return; }
    try {
      const items = colorGroups.flatMap(group => {
        const colorObj = colorOptions.find(c => c.id === group.color_id);
        const colorLabel = colorObj ? colorObj.color_name : '';
        return group.sizes.filter(s => s.size_eu && s.quantity).map(s => ({
          size: s.size_eu,
          quantity: parseInt(s.quantity),
          color_label: colorLabel || null,
        }));
      });
      if (items.length === 0) { toast.error('Add at least one size before saving a template'); return; }

      const productId = editBoxDetails?.product_id || boxForm?.product_id || null;
      await boxTemplatesAPI.create({
        name: saveTemplateName.trim(),
        product_id: productId || null,
        items,
      });
      toast.success('Template saved!');
      setShowSaveTemplate(false);
      setSaveTemplateName('');
      // Refresh templates list
      const { data } = await boxTemplatesAPI.list();
      setTemplates(data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to save template');
    }
  };

  // --- Load colors when product changes ---
  const handleProductChange = async (productId) => {
    setBoxForm({ ...boxForm, product_id: productId });
    // Reset colors/sizes array
    if (productId) {
      try {
        const { data } = await productsAPI.listColors(productId);
        setColorOptions(data.data);
      } catch { setColorOptions([]); }
    } else { 
      setColorOptions([]); 
    }
    setColorGroups([{ color_id: '', sizes: [{ size_eu: '', size_us: '', size_uk: '', size_cm: '', quantity: '' }] }]);
  };

  // --- Add Box ---
  const handleAddBox = async (e) => {
    e.preventDefault();
    try {
      // Input Validation
      const totalItemsEntered = colorGroups.reduce((acc, g) => 
        acc + g.sizes.reduce((sum, s) => sum + (parseInt(s.quantity) || 0), 0)
      , 0);

      const payload = {
        ...boxForm,
        product_id: boxForm.product_id || null,
        destination_store_id: boxForm.destination_store_id || null,
        cost_per_item: parseFloat(boxForm.cost_per_item),
        total_items: totalItemsEntered > 0 ? totalItemsEntered : parseInt(boxForm.total_items),
      };

      // 1. Create the box
      const res = await purchasesAPI.addBox(id, payload);
      const newBox = res.data.data;

      // 2. Attach items if provided
      if (totalItemsEntered > 0 && newBox.product_id) {
        const itemsToSave = colorGroups.flatMap(group => 
          group.sizes.filter(s => s.size_eu && s.quantity).map(s => ({
            product_color_id: group.color_id || null,
            size_eu: s.size_eu,
            size_us: s.size_us || null,
            size_uk: s.size_uk || null,
            size_cm: s.size_cm !== '' ? parseFloat(s.size_cm) : null,
            quantity: parseInt(s.quantity),
          }))
        );
        console.log('handleAddBox itemsToSave:', itemsToSave);
        if (itemsToSave.length > 0) {
          await purchasesAPI.setBoxItems(newBox.id, itemsToSave);
        }
      }

      toast.success('Box created successfully');
      setShowBoxForm(false);
      setBoxForm({ product_id: '', cost_per_item: '', total_items: '', destination_store_id: '', notes: '' });
      setColorGroups([{ color_id: '', sizes: [{ size_eu: '', size_us: '', size_uk: '', size_cm: '', quantity: '' }] }]);
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to create box');
    }
  };

  // --- Delete Box ---
  const handleDeleteBox = async (boxId) => {
    if (!confirm('Delete this box?')) return;
    try {
      await purchasesAPI.deleteBox(boxId);
      toast.success('Box deleted');
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cannot delete box');
    }
  };

  // --- Set Box Items & Details ---
  const [editBoxDetails, setEditBoxDetails] = useState({ product_id: '', destination_store_id: '' });
  const [colorGroups, setColorGroups] = useState([]);

  // Smart Box Items Generator states
  const [boxGenColor, setBoxGenColor] = useState('');
  const [boxGenStart, setBoxGenStart] = useState('');
  const [boxGenEnd, setBoxGenEnd] = useState('');
  const [boxGenQty, setBoxGenQty] = useState('1');
  
  const startEditItems = async (box) => {
    setEditingBoxId(box.id);
    setEditBoxDetails({
      product_id: box.product_id || '',
      destination_store_id: box.destination_store_id || '',
    });
    
    // Load colors right away if product is selected
    if (box.product_id) {
      try {
        const { data } = await productsAPI.listColors(box.product_id);
        setColorOptions(data.data);
      } catch { setColorOptions([]); }
    } else {
      setColorOptions([]);
    }

    if (box.items && box.items.length > 0) {
      // Group by color
      const groups = {};
      box.items.forEach(i => {
        const cId = i.product_color_id || 'unassigned';
        if (!groups[cId]) groups[cId] = [];
        groups[cId].push({
          size_eu: i.size_eu, size_us: i.size_us || '', size_uk: i.size_uk || '',
          size_cm: i.size_cm != null ? i.size_cm : '', quantity: i.quantity,
        });
      });
      const newGroups = Object.keys(groups).map(k => ({
        color_id: k === 'unassigned' ? '' : k,
        sizes: groups[k]
      }));
      setColorGroups(newGroups);
    } else {
      setColorGroups([{ color_id: '', sizes: [{ size_eu: '', size_us: '', size_uk: '', size_cm: '', quantity: '' }] }]);
    }
  };

  const handleEditProductChange = async (productId) => {
    setEditBoxDetails({ ...editBoxDetails, product_id: productId });
    if (productId) {
      try {
        const { data } = await productsAPI.listColors(productId);
        setColorOptions(data.data);
      } catch { setColorOptions([]); }
    } else { setColorOptions([]); }
  };

  const addColorGroup = () => {
    setColorGroups([...colorGroups, { color_id: '', sizes: [{ size_eu: '', size_us: '', size_uk: '', size_cm: '', quantity: '' }] }]);
  };

  const removeColorGroup = (idx) => {
    setColorGroups(colorGroups.filter((_, i) => i !== idx));
  };

  const updateColorGroupColor = (idx, colorId) => {
    const updated = [...colorGroups];
    updated[idx].color_id = colorId;
    setColorGroups(updated);
  };

  const addSizeRow = (groupIdx) => {
    const updated = JSON.parse(JSON.stringify(colorGroups));
    updated[groupIdx].sizes.push({ size_eu: '', size_us: '', size_uk: '', size_cm: '', quantity: '' });
    setColorGroups(updated);
  };

  const removeSizeRow = (groupIdx, rowIdx) => {
    const updated = JSON.parse(JSON.stringify(colorGroups));
    updated[groupIdx].sizes = updated[groupIdx].sizes.filter((_, i) => i !== rowIdx);
    setColorGroups(updated);
  };

  const updateSizeRow = (groupIdx, rowIdx, field, value) => {
    const updated = JSON.parse(JSON.stringify(colorGroups));
    updated[groupIdx].sizes[rowIdx][field] = value;
    setColorGroups(updated);
  };

  const handleSmartGenerateBoxItems = () => {
    if (!boxGenStart || !boxGenEnd) {
      toast.error('Please specify start and end sizes.');
      return;
    }
    const start = parseInt(boxGenStart, 10);
    const end = parseInt(boxGenEnd, 10);
    if (isNaN(start) || isNaN(end) || start > end) {
      toast.error('Invalid size range.');
      return;
    }
    
    // Create new items
    const newItems = [];
    const qty = parseInt(boxGenQty) || 1;
    for (let s = start; s <= end; s++) {
      newItems.push({ size_eu: String(s), size_us: '', size_uk: '', size_cm: '', quantity: String(qty) });
    }

    const updated = JSON.parse(JSON.stringify(colorGroups));
    
    // Find if a color group already exists for this color
    let groupIdx = updated.findIndex((g) => g.color_id === boxGenColor);
    if (groupIdx === -1) {
      // Remove the completely empty group if it's there
      if (updated.length === 1 && updated[0].color_id === '' && updated[0].sizes.length === 1 && !updated[0].sizes[0].size_eu) {
        updated.pop();
      }
      updated.push({ color_id: boxGenColor, sizes: newItems });
    } else {
      // Append strictly non-overlapping sizes to the existing group
      const existingSizes = new Set(updated[groupIdx].sizes.map(s => s.size_eu));
      const filteredNewItems = newItems.filter(i => !existingSizes.has(i.size_eu));
      if (filteredNewItems.length < newItems.length) {
         toast.success('Generated sizes, skipped some that were already there.');
      }
      updated[groupIdx].sizes.push(...filteredNewItems);
      // Sort existing group sizes nicely
      updated[groupIdx].sizes.sort((a,b) => parseInt(a.size_eu) - parseInt(b.size_eu));
    }
    
    setColorGroups(updated);
  };

  const handleSaveBoxAll = async () => {
    try {
      // 1. Save Box Details (product, store)
      await purchasesAPI.updateBox(editingBoxId, {
        product_id: editBoxDetails.product_id || null,
        destination_store_id: editBoxDetails.destination_store_id || null,
      });

      // 2. Save Items (sizes & colors)
      const items = colorGroups.flatMap(group => 
        group.sizes.filter(s => s.size_eu && s.quantity).map(s => ({
          product_color_id: group.color_id || null,
          size_eu: s.size_eu,
          size_us: s.size_us || null,
          size_uk: s.size_uk || null,
          size_cm: s.size_cm !== '' ? parseFloat(s.size_cm) : null,
          quantity: parseInt(s.quantity),
        }))
      );
      console.log('handleSaveBoxAll mapped items:', items, 'from colorGroups:', colorGroups);
      await purchasesAPI.setBoxItems(editingBoxId, items);
      
      toast.success('Box details & items saved');
      setEditingBoxId(null);
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to save box');
    }
  };

  // --- Complete Box ---
  const handleCompleteBox = async (boxId) => {
    if (!confirm('Complete this box? This will create inventory items and cannot be undone.')) return;
    try {
      await purchasesAPI.completeBox(boxId);
      toast.success('Box completed — inventory items created!');
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cannot complete box');
    }
  };

  // --- Payment ---
  const handleCreatePayment = async (e) => {
    e.preventDefault();
    try {
      await purchasesAPI.createPayment({
        supplier_id: invoice.supplier_id,
        total_amount: parseFloat(paymentForm.total_amount),
        payment_method: paymentForm.payment_method,
        payment_date: paymentForm.payment_date,
        reference_no: paymentForm.reference_no || null,
        notes: paymentForm.notes || null,
      });
      toast.success('Payment recorded & auto-allocated');
      setShowPaymentForm(false);
      setPaymentForm({ total_amount: '', payment_method: 'cash', payment_date: new Date().toISOString().split('T')[0], reference_no: '', notes: '' });
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to create payment');
    }
  };

  // --- Upload Attached Image (Images Tab) ---
  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      await purchasesAPI.uploadInvoiceImage(id, formData);
      toast.success('Image uploaded');
      fetchAll();
    } catch { toast.error('Failed to upload'); }
    e.target.value = '';
  };

  // --- Delete Attached Image ---
  const handleDeleteAttachedImage = async (e, imageId) => {
    e.stopPropagation();
    if (!confirm('Delete this attached image?')) return;
    try {
      await purchasesAPI.deleteInvoiceImage(id, imageId);
      toast.success('Image deleted');
      fetchAll();
    } catch { toast.error('Failed to delete image'); }
  };

  const handleUpdateInvoice = async (e) => {
    e.preventDefault();
    try {
      await purchasesAPI.updateInvoice(id, {
        total_amount: parseFloat(editInvoiceForm.total_amount),
        discount_amount: parseFloat(editInvoiceForm.discount_amount) || 0,
        invoice_date: editInvoiceForm.invoice_date,
        notes: editInvoiceForm.notes || null,
      });

      // Handle primary image upload if a new file is chosen in the edit modal
      if (fileInputRef.current?.files?.[0]) {
        const formData = new FormData();
        formData.append('image', fileInputRef.current.files[0]);
        await purchasesAPI.uploadPrimaryImage(id, formData);
        fileInputRef.current.value = '';
      }

      toast.success('Invoice updated successfully');
      setShowEditInvoice(false);
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update invoice');
    }
  };

  // --- Remove Primary Document ---
  const handleRemovePrimaryDocument = async () => {
    if (!confirm('Remove the primary invoice document?')) return;
    try {
      await purchasesAPI.updateInvoice(id, { invoice_image_url: null });
      toast.success('Primary document removed');
      fetchAll();
    } catch { toast.error('Failed to remove document'); }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!invoice) return null;

  const statusColors = { pending: 'badge-warning', partial: 'badge-info', paid: 'badge-success' };
  const boxStatusColors = { pending: 'badge-warning', partial: 'badge-info', complete: 'badge-success' };
  const owed = parseFloat(invoice.total_amount) - (parseFloat(invoice.discount_amount) || 0) - parseFloat(invoice.paid_amount);

  return (
    <div className="product-detail">
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/purchases')} style={{ marginBottom: 8 }}>
            ← Back to Purchases
          </button>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {invoice.invoice_number}
            <span className={`badge ${statusColors[invoice.status]}`}>{invoice.status}</span>
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginTop: 4 }}>
            Supplier: <strong>{invoice.supplier_name}</strong> &nbsp;•&nbsp;
            Date: {new Date(invoice.invoice_date).toLocaleDateString()} &nbsp;•&nbsp;
            Total: <strong>{parseFloat(invoice.total_amount).toLocaleString()} EGP</strong> 
            {parseFloat(invoice.discount_amount) > 0 && ` (Discount: ${parseFloat(invoice.discount_amount).toLocaleString()} EGP)`} &nbsp;•&nbsp;
            Paid: {parseFloat(invoice.paid_amount).toLocaleString()} EGP &nbsp;•&nbsp;
            <span style={{ color: owed > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>
              Owed: {owed.toLocaleString()} EGP
            </span>
          </p>
          {invoice.notes && <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9em', marginTop: 4 }}>Notes: {invoice.notes}</p>}
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
          {invoice.invoice_image_url && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button 
                className="btn btn-secondary btn-sm" 
                title="View Primary Invoice Document"
                onClick={() => setViewerImage({ url: invoice.invoice_image_url, title: 'Primary Invoice Document' })}
              >
                📄 View Document
              </button>
              {canWrite && (
                <button className="btn btn-danger btn-sm" title="Remove Document" onClick={handleRemovePrimaryDocument}>
                  ✖
                </button>
              )}
            </div>
          )}
          {canWrite && (
            <button className="btn btn-secondary btn-sm" onClick={() => {
              setEditInvoiceForm({
                total_amount: invoice.total_amount,
                discount_amount: invoice.discount_amount || 0,
                invoice_date: new Date(invoice.invoice_date).toISOString().split('T')[0],
                notes: invoice.notes || '',
              });
              setShowEditInvoice(true);
            }}>
              ✎ Edit Invoice
            </button>
          )}
        </div>
      </div>

      {/* Edit Invoice Modal */}
      {showEditInvoice && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 500 }}>
            <h2>Edit Invoice Details</h2>
            <form onSubmit={handleUpdateInvoice} style={{ marginTop: 'var(--spacing-md)' }}>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Total Amount (EGP)</label>
                  <input className="form-input" type="number" step="0.01" required value={editInvoiceForm.total_amount}
                    onChange={e => setEditInvoiceForm({...editInvoiceForm, total_amount: e.target.value})} />
                </div>
                <div className="form-group">
                  <label className="form-label">Discount Amount (EGP)</label>
                  <input className="form-input" type="number" step="0.01" min="0" value={editInvoiceForm.discount_amount}
                    onChange={e => setEditInvoiceForm({...editInvoiceForm, discount_amount: e.target.value})} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Invoice Date</label>
                <input className="form-input" type="date" required value={editInvoiceForm.invoice_date}
                  onChange={e => setEditInvoiceForm({...editInvoiceForm, invoice_date: e.target.value})} />
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea className="form-input" rows="2" value={editInvoiceForm.notes} placeholder="Optional notes"
                  onChange={e => setEditInvoiceForm({...editInvoiceForm, notes: e.target.value})} />
              </div>
              <div className="form-group">
                <label className="form-label">Primary Invoice Document (Optional Image)</label>
                <input ref={fileInputRef} type="file" accept="image/*" className="form-input" />
              </div>
              
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowEditInvoice(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {['boxes', 'payments', 'images'].map((tab) => (
          <button key={tab} className={`tab ${activeTab === tab ? 'tab--active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'boxes' ? `Boxes (${invoice.boxes.length})` : tab === 'payments' ? `Payments (${invoice.allocations.length})` : `Images (${invoice.images.length})`}
          </button>
        ))}
      </div>

      {/* === BOXES TAB === */}
      {activeTab === 'boxes' && (
        <div className="tab-content">
          {canWrite && (
            <div style={{ marginBottom: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-sm)' }}>
              <button className="btn btn-primary" onClick={() => setShowBoxForm(true)}>+ Add Box</button>
            </div>
          )}

          {/* Add Box Form */}
          {showBoxForm && (
            <div className="card" style={{ marginBottom: 'var(--spacing-lg)' }}>
              <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Add Box</h3>
              <form onSubmit={handleAddBox} className="product-form">
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Product <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8em' }}>(optional)</span></label>
                    <SearchableSelect
                      options={[
                        { value: '', label: 'Not yet known' },
                        ...products.map(p => ({ value: p.id, label: `${p.product_code} — ${p.model_name}` }))
                      ]}
                      value={boxForm.product_id}
                      onChange={(e) => handleProductChange(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Destination store</label>
                    <SearchableSelect
                      options={[
                        { value: '', label: 'Not yet assigned' },
                        ...stores.map((s) => ({ value: s.id, label: s.name }))
                      ]}
                      value={boxForm.destination_store_id}
                      onChange={(e) => setBoxForm({ ...boxForm, destination_store_id: e.target.value })}
                    />
                  </div>
                </div>
                {/* Template Picker */}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">📦 Apply Template <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8em' }}>(auto-fill sizes)</span></label>
                    <SearchableSelect
                      options={[
                        { value: '', label: '— No template —' },
                        ...(boxForm.product_id
                          ? templates.filter(t => t.product_id === boxForm.product_id).map(t => ({ value: t.id, label: `⭐ ${t.name} (${t.items.reduce((s,i) => s+i.quantity,0)} items)` }))
                          : []
                        ),
                        ...templates.filter(t => !t.product_id || t.product_id !== boxForm.product_id).map(t => ({ value: t.id, label: `${t.name} (${t.items.reduce((s,i) => s+i.quantity,0)} items)${t.product_name ? ' — ' + t.product_name : ''}` }))
                      ]}
                      value=""
                      onChange={(e) => { if (e.target.value) applyTemplate(e.target.value, colorOptions); }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Cost per item (EGP) *</label>
                    <input className="form-input" type="number" step="0.01" required value={boxForm.cost_per_item}
                      onChange={(e) => setBoxForm({ ...boxForm, cost_per_item: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Total items in box *</label>
                    <input className="form-input" type="number" required value={boxForm.total_items}
                      onChange={(e) => setBoxForm({ ...boxForm, total_items: e.target.value })} />
                  </div>
                  <div className="form-group">
                    {/* Empty to align to grid */}
                  </div>
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setShowBoxForm(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Add Box</button>
                </div>
              </form>
            </div>
          )}

          {/* Box List */}
          {invoice.boxes.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-2xl)' }}>
              No boxes yet. Add boxes to this invoice to track what was purchased.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
              {invoice.boxes.map((box, idx) => (
                <div key={box.id} className="card" style={{ position: 'relative', width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
                    <h3 style={{ margin: 0 }}>Box #{idx + 1}</h3>
                    <span className={`badge ${boxStatusColors[box.detail_status]}`}>{box.detail_status}</span>
                  </div>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', display: 'grid', gap: 4 }}>
                    <div>Product: <strong>{box.product_name ? `${box.product_code} — ${box.product_name}` : 'Not set'}</strong></div>
                    <div>Items: <strong>{box.total_items}</strong> × {parseFloat(box.cost_per_item).toLocaleString()} EGP</div>
                    <div>Store: <strong>{box.store_name || 'Not assigned'}</strong></div>
                  </div>

                  {/* Box Items */}
                  {box.items && box.items.length > 0 && (
                    <div style={{ marginTop: 'var(--spacing-md)' }}>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 6 }}>Sizes & Colors:</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {box.items.map((item, i) => (
                          <span key={i} className="badge badge-neutral" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {item.color_name && <strong style={{color: 'var(--color-primary)'}}>{item.color_name}</strong>}
                            EU {item.size_eu} ×{item.quantity}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  {canWrite && box.detail_status !== 'complete' && (
                    <div style={{ marginTop: 'var(--spacing-md)', display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => startEditItems(box)}>
                        {box.items?.length ? 'Edit Items (Colors/Sizes)' : '+ Add Items'}
                      </button>
                      {box.product_id && box.destination_store_id && box.items?.length > 0 && (
                        <button className="btn btn-sm btn-primary" onClick={() => handleCompleteBox(box.id)}>
                          ✓ Complete Box
                        </button>
                      )}
                      <button className="btn btn-sm btn-danger" onClick={() => handleDeleteBox(box.id)}>Delete</button>
                    </div>
                  )}
                  {box.detail_status === 'complete' && (
                    <div style={{ marginTop: 'var(--spacing-md)', color: 'var(--color-success)', fontWeight: 600, fontSize: 'var(--font-size-sm)' }}>
                      ✓ Complete — inventory items created
                    </div>
                  )}

                  {/* Edit Items Inline */}
                  {editingBoxId === box.id && (
                    <div className="card" style={{ marginTop: 'var(--spacing-lg)', borderTop: '4px solid var(--color-primary)', backgroundColor: 'var(--color-bg-secondary)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
                        <h4 style={{ margin: 0 }}>Edit Box Details & Sizes</h4>
                        <div className="form-group" style={{ margin: 0, minWidth: 280 }}>
                          <SearchableSelect
                            options={[
                              { value: '', label: '📦 Apply Template...' },
                              ...(editBoxDetails.product_id
                                ? templates.filter(t => t.product_id === editBoxDetails.product_id).map(t => ({ value: t.id, label: `⭐ ${t.name} (${t.items.reduce((s,i) => s+i.quantity,0)} items)` }))
                                : []
                              ),
                              ...templates.filter(t => !t.product_id || t.product_id !== editBoxDetails.product_id).map(t => ({ value: t.id, label: `${t.name} (${t.items.reduce((s,i) => s+i.quantity,0)} items)${t.product_name ? ' — ' + t.product_name : ''}` }))
                            ]}
                            value=""
                            onChange={(e) => { if (e.target.value) applyTemplate(e.target.value, colorOptions); }}
                          />
                        </div>
                      </div>
                      
                      <div className="form-row" style={{ marginBottom: 'var(--spacing-md)' }}>
                        <div className="form-group">
                          <label className="form-label">Product</label>
                          <SearchableSelect
                            options={[
                              { value: '', label: 'Not assigned' },
                              ...products.map(p => ({ value: p.id, label: `${p.product_code} — ${p.model_name}` }))
                            ]}
                            value={editBoxDetails.product_id}
                            onChange={(e) => handleEditProductChange(e.target.value)}
                          />
                        </div>
                        <div className="form-group" style={{ flex: 1 }}>
                          <label className="form-label">Destination Store</label>
                          <SearchableSelect
                            options={[
                              { value: '', label: 'Not assigned' },
                              ...stores.map((s) => ({ value: s.id, label: s.name }))
                            ]}
                            value={editBoxDetails.destination_store_id}
                            onChange={(e) => setEditBoxDetails({ ...editBoxDetails, destination_store_id: e.target.value })}
                          />
                        </div>
                      </div>

                      <div style={{ marginBottom: 'var(--spacing-md)', padding: 'var(--spacing-md)', backgroundColor: 'var(--color-bg-base)', borderRadius: 8, border: '1px solid var(--color-primary)' }}>
                        <h4 style={{ marginBottom: 'var(--spacing-md)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          ⚡ Smart Generator
                        </h4>
                        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', marginBottom: 8 }}>Select a color and size range to quickly generate item rows.</p>
                        <div className="form-row" style={{ alignItems: 'flex-end', marginBottom: 0 }}>
                          <div className="form-group" style={{ flex: 1.5, margin: 0 }}>
                            <label className="form-label">Target Color</label>
                            <SearchableSelect
                              options={[
                                { value: '', label: 'No Color Selected' },
                                ...colorOptions.map((c) => ({ value: c.id, label: c.color_name }))
                              ]}
                              value={boxGenColor}
                              onChange={(e) => setBoxGenColor(e.target.value)}
                            />
                          </div>
                          <div className="form-group" style={{ flex: 1, margin: 0 }}>
                            <label className="form-label">Start EU</label>
                            <input className="form-input" type="number" value={boxGenStart} onChange={e => setBoxGenStart(e.target.value)} placeholder="38" />
                          </div>
                          <div className="form-group" style={{ flex: 1, margin: 0 }}>
                            <label className="form-label">End EU</label>
                            <input className="form-input" type="number" value={boxGenEnd} onChange={e => setBoxGenEnd(e.target.value)} placeholder="45" />
                          </div>
                          <div className="form-group" style={{ flex: 1, margin: 0 }}>
                            <label className="form-label">Qty/Size</label>
                            <input className="form-input" type="number" min="1" value={boxGenQty} onChange={e => setBoxGenQty(e.target.value)} placeholder="1" />
                          </div>
                          <button type="button" className="btn btn-primary" onClick={handleSmartGenerateBoxItems}>
                            Generate Sizes
                          </button>
                        </div>
                      </div>

                      <h4 style={{ marginBottom: 'var(--spacing-sm)', fontSize: '1em' }}>Items Distribution (total must equal {box.total_items})</h4>
                      
                      {colorGroups.map((group, gIdx) => (
                        <div key={gIdx} style={{ marginBottom: 'var(--spacing-md)', padding: 'var(--spacing-md)', backgroundColor: 'var(--color-bg-base)', borderRadius: 8, border: '1px solid var(--color-border)', overflowX: 'auto' }}>
                          <div style={{ display: 'flex', gap: 'var(--spacing-md)', alignItems: 'center', marginBottom: 'var(--spacing-sm)', minWidth: 600 }}>
                            <div className="form-group" style={{ margin: 0, width: 250 }}>
                              <SearchableSelect
                                required
                                options={[
                                  { value: '', label: 'Select Color...' },
                                  ...colorOptions.map((c) => ({ value: c.id, label: c.color_name }))
                                ]}
                                value={group.color_id}
                                onChange={(e) => updateColorGroupColor(gIdx, e.target.value)}
                                style={{ borderColor: 'var(--color-primary)' }}
                              />
                            </div>
                            {colorGroups.length > 1 && (
                              <button className="btn btn-sm btn-danger" onClick={() => removeColorGroup(gIdx)}>Remove Color Branch</button>
                            )}
                          </div>

                          <div className="table-responsive">
                            <table className="table" style={{ width: '100%', minWidth: 600 }}>
                              <thead>
                                <tr>
                                  <th style={{width: 60, padding: '0.5rem'}}>EU *</th>
                                  <th style={{width: 60, padding: '0.5rem'}}>Qty *</th>
                                  <th style={{width: 55, padding: '0.5rem'}}>US</th>
                                  <th style={{width: 55, padding: '0.5rem'}}>UK</th>
                                  <th style={{width: 60, padding: '0.5rem'}}>CM</th>
                                  <th style={{width: 40, padding: '0.5rem'}}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.sizes.map((item, rowIdx) => (
                                  <tr key={rowIdx}>
                                    <td style={{padding: '0.2rem 0.5rem'}}>
                                      <input className="form-input" required value={item.size_eu} style={{ padding: '0.4rem', minWidth: 40 }}
                                        onChange={(e) => updateSizeRow(gIdx, rowIdx, 'size_eu', e.target.value)} />
                                    </td>
                                    <td style={{padding: '0.2rem 0.5rem'}}>
                                      <input className="form-input" required type="number" min="1" value={item.quantity} style={{ padding: '0.4rem', minWidth: 40 }}
                                        onChange={(e) => updateSizeRow(gIdx, rowIdx, 'quantity', e.target.value)} />
                                    </td>
                                    <td style={{padding: '0.2rem 0.5rem'}}>
                                        <input className="form-input" value={item.size_us} style={{ padding: '0.4rem', minWidth: 40 }} 
                                        onChange={(e) => updateSizeRow(gIdx, rowIdx, 'size_us', e.target.value)} />
                                    </td>
                                    <td style={{padding: '0.2rem 0.5rem'}}>
                                        <input className="form-input" value={item.size_uk} style={{ padding: '0.4rem', minWidth: 40 }} 
                                        onChange={(e) => updateSizeRow(gIdx, rowIdx, 'size_uk', e.target.value)} />
                                    </td>
                                    <td style={{padding: '0.2rem 0.5rem'}}>
                                        <input className="form-input" type="number" step="0.1" value={item.size_cm} style={{ padding: '0.4rem', minWidth: 45 }} 
                                        onChange={(e) => updateSizeRow(gIdx, rowIdx, 'size_cm', e.target.value)} />
                                    </td>
                                    <td style={{padding: '0.2rem 0.5rem', textAlign: 'right'}}>
                                      {group.sizes.length > 1 && (
                                        <button className="btn btn-sm btn-danger" style={{ padding: '0.2rem 0.4rem' }} onClick={() => removeSizeRow(gIdx, rowIdx)}>✕</button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <button className="btn btn-sm btn-secondary" style={{ marginTop: 'var(--spacing-sm)' }} onClick={() => addSizeRow(gIdx)}>+ Add Size</button>
                        </div>
                      ))}

                      <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-md)', flexWrap: 'wrap' }}>
                        <button className="btn btn-sm btn-secondary" onClick={addColorGroup}>+ Add Another Color</button>
                        {!showSaveTemplate ? (
                          <button className="btn btn-sm btn-secondary" style={{ background: 'var(--color-bg-base)', border: '1px dashed var(--color-primary)' }} onClick={() => setShowSaveTemplate(true)}>💾 Save as Template</button>
                        ) : (
                          <div style={{ display: 'flex', gap: 'var(--spacing-xs)', alignItems: 'center' }}>
                            <input className="form-input" placeholder="Template name..." value={saveTemplateName} onChange={(e) => setSaveTemplateName(e.target.value)} style={{ padding: '0.3rem 0.5rem', width: 180 }} />
                            <button className="btn btn-sm btn-primary" onClick={handleSaveAsTemplate}>Save</button>
                            <button className="btn btn-sm btn-secondary" onClick={() => { setShowSaveTemplate(false); setSaveTemplateName(''); }}>✕</button>
                          </div>
                        )}
                        <div style={{ flex: 1 }} />
                        <button className="btn btn-sm btn-secondary" onClick={() => setEditingBoxId(null)}>Cancel</button>
                        <button className="btn btn-sm btn-primary" onClick={handleSaveBoxAll}>Save Box</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === PAYMENTS TAB === */}
      {activeTab === 'payments' && (
        <div className="tab-content">
          <div className="card" style={{ marginBottom: 'var(--spacing-lg)' }}>
            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>Payment Summary</h3>
            <p style={{ color: 'var(--color-text-secondary)' }}>
              Total: <strong>{parseFloat(invoice.total_amount).toLocaleString()} EGP</strong> &nbsp;|&nbsp;
              Paid: <strong>{parseFloat(invoice.paid_amount).toLocaleString()} EGP</strong> &nbsp;|&nbsp;
              <span style={{ color: owed > 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>
                Remaining: {owed.toLocaleString()} EGP
              </span>
            </p>
          </div>
          {canWrite && owed > 0 && (
            <div style={{ marginBottom: 'var(--spacing-lg)' }}>
              {!showPaymentForm ? (
                <button className="btn btn-primary" onClick={() => {
                  setPaymentForm({ ...paymentForm, total_amount: owed });
                  setShowPaymentForm(true);
                }}>+ Record Payment</button>
              ) : (
                <div className="card">
                  <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Record Payment to {invoice.supplier_name}</h3>
                  <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-md)' }}>
                    Payment will be auto-allocated to this supplier's oldest unpaid invoices (FIFO).
                  </p>
                  <form onSubmit={handleCreatePayment} className="product-form">
                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">Amount (EGP) *</label>
                        <input className="form-input" type="number" step="0.01" required value={paymentForm.total_amount}
                          onChange={(e) => setPaymentForm({ ...paymentForm, total_amount: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Payment Date *</label>
                        <input className="form-input" type="date" required value={paymentForm.payment_date}
                          onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Payment Method *</label>
                        <SearchableSelect
                          required
                          options={[
                            { value: '', label: 'Select method...' },
                            { value: 'cash', label: 'Cash' },
                            { value: 'bank_transfer', label: 'Bank Transfer' },
                            { value: 'cheque', label: 'Cheque' },
                            { value: 'instapay', label: 'InstaPay' },
                            { value: 'vodafone_cash', label: 'Vodafone Cash' },
                            { value: 'other', label: 'Other' }
                          ]}
                          value={paymentForm.payment_method}
                          onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Reference # (for transfers)</label>
                      <input className="form-input" value={paymentForm.reference_no}
                        onChange={(e) => setPaymentForm({ ...paymentForm, reference_no: e.target.value })} />
                    </div>
                    <div className="form-actions">
                      <button type="button" className="btn btn-secondary" onClick={() => setShowPaymentForm(false)}>Cancel</button>
                      <button type="submit" className="btn btn-primary">Record Payment</button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          )}

          {invoice.allocations.length > 0 ? (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr><th>Date</th><th>Method</th><th>Amount</th><th>Reference</th></tr>
                </thead>
                <tbody>
                  {invoice.allocations.map((a) => (
                    <tr key={a.id}>
                      <td>{new Date(a.payment_date).toLocaleDateString()}</td>
                      <td><span className="badge badge-neutral">{a.payment_method}</span></td>
                      <td><strong>{parseFloat(a.allocated_amount).toLocaleString()} EGP</strong></td>
                      <td>{a.reference_no || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
              No payments allocated to this invoice yet.
            </div>
          )}
        </div>
      )}

      {/* === IMAGES TAB === */}
      {activeTab === 'images' && (
        <div className="tab-content">
          {canWrite && (
            <div style={{ marginBottom: 'var(--spacing-lg)' }}>
              <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>+ Upload Invoice Image</button>
              <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleImageUpload} />
            </div>
          )}

          {invoice.images.length > 0 ? (
            <div className="color-images" style={{ gap: 'var(--spacing-md)' }}>
              {invoice.images.map((img) => (
                <div 
                  key={img.id} 
                  style={{ width: 200, borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--color-border)', position: 'relative', cursor: 'pointer' }}
                  onClick={() => setViewerImage({ url: img.image_url, title: img.original_name })}
                >
                  <img src={img.image_url} alt={img.original_name} style={{ width: '100%', display: 'block' }} />
                  <div style={{ padding: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden' }} title={img.original_name}>{img.original_name}</span>
                    {canWrite && (
                      <button className="btn btn-danger btn-sm" style={{ padding: '2px 6px', fontSize: '10px' }} onClick={(e) => handleDeleteAttachedImage(e, img.id)} title="Delete Image">✖</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
              No invoice images. Upload scanned invoices or photos here.
            </div>
          )}
        </div>
      )}
      {/* Image Viewer Modal */}
      {viewerImage && (
        <ImageViewerModal 
          imageUrl={viewerImage.url} 
          title={viewerImage.title} 
          onClose={() => setViewerImage(null)} 
        />
      )}

    </div>
  );
}
