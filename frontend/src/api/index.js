import api from './client';

export const authAPI = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  refresh: (refreshToken) => api.post('/auth/refresh', { refreshToken }),
  logout: (refreshToken) => api.post('/auth/logout', { refreshToken }),
  me: () => api.get('/auth/me'),
};

export const storesAPI = {
  list: () => api.get('/stores'),
  getById: (id) => api.get(`/stores/${id}`),
  create: (data) => api.post('/stores', data),
  update: (id, data) => api.put(`/stores/${id}`, data),
};

export const usersAPI = {
  list: () => api.get('/users'),
  getById: (id) => api.get(`/users/${id}`),
  create: (data) => api.post('/users', data),
  update: (id, data) => api.put(`/users/${id}`, data),
  deactivate: (id) => api.delete(`/users/${id}`),
  setPermissions: (id, permissions) => api.put(`/users/${id}/permissions`, { permissions }),
  changePassword: (data) => api.put('/users/change-password', data),
  listRoles: () => api.get('/users/roles'),
  listPermissions: () => api.get('/users/permissions'),
  getStores: (id) => api.get(`/users/${id}/stores`),
  setStores: (id, storeIds) => api.put(`/users/${id}/stores`, { store_ids: storeIds }),
};

export const productsAPI = {
  list: (params) => api.get('/products', { params }),
  getById: (id) => api.get(`/products/${id}`),
  create: (data) => api.post('/products', data),
  update: (id, data) => api.put(`/products/${id}`, data),
  toggleActive: (id) => api.patch(`/products/${id}/toggle-active`),
  // Colors
  listColors: (productId) => api.get(`/products/${productId}/colors`),
  createColor: (productId, data) => api.post(`/products/${productId}/colors`, data),
  updateColor: (productId, colorId, data) => api.put(`/products/${productId}/colors/${colorId}`, data),
  deleteColor: (productId, colorId) => api.delete(`/products/${productId}/colors/${colorId}`),
  // Images
  uploadImage: (productId, colorId, formData) =>
    api.post(`/products/${productId}/colors/${colorId}/images`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  setPrimaryImage: (productId, imageId) => api.put(`/products/${productId}/images/${imageId}/primary`),
  deleteImage: (productId, imageId) => api.delete(`/products/${productId}/images/${imageId}`),
  // Variants
  listVariants: (productId) => api.get(`/products/${productId}/variants`),
  createVariant: (productId, data) => api.post(`/products/${productId}/variants`, data),
  bulkCreateVariants: (productId, data) => api.post(`/products/${productId}/variants/bulk`, data),
  updateVariant: (productId, variantId, data) => api.put(`/products/${productId}/variants/${variantId}`, data),
  deleteVariant: (productId, variantId) => api.delete(`/products/${productId}/variants/${variantId}`),
  // Store prices
  getStorePrices: (productId) => api.get(`/products/${productId}/prices`),
  setStorePrice: (productId, storeId, data) => api.put(`/products/${productId}/prices/${storeId}`, data),
  deleteStorePrice: (productId, storeId) => api.delete(`/products/${productId}/prices/${storeId}`),
};

export const boxTemplatesAPI = {
  list: (params) => api.get('/box-templates', { params }),
  getById: (id) => api.get(`/box-templates/${id}`),
  create: (data) => api.post('/box-templates', data),
  update: (id, data) => api.put(`/box-templates/${id}`, data),
  delete: (id) => api.delete(`/box-templates/${id}`),
};

export const suppliersAPI = {
  list: () => api.get('/suppliers'),
  getById: (id) => api.get(`/suppliers/${id}`),
  create: (data) => api.post('/suppliers', data),
  update: (id, data) => api.put(`/suppliers/${id}`, data),
  delete: (id) => api.delete(`/suppliers/${id}`),
};

export const purchasesAPI = {
  // Invoices
  listInvoices: (params) => api.get('/purchases/invoices', { params }),
  getInvoice: (id) => api.get(`/purchases/invoices/${id}`),
  createInvoice: (data) => api.post('/purchases/invoices', data),
  updateInvoice: (id, data) => api.put(`/purchases/invoices/${id}`, data),
  deleteInvoice: (id) => api.delete(`/purchases/invoices/${id}`),
  uploadPrimaryImage: (id, formData) =>
    api.post(`/purchases/invoices/${id}/primary-image`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  uploadInvoiceImage: (id, formData) =>
    api.post(`/purchases/invoices/${id}/images`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  deleteInvoiceImage: (id, imageId) => api.delete(`/purchases/invoices/${id}/images/${imageId}`),
  // Boxes
  addBox: (invoiceId, data) => api.post(`/purchases/invoices/${invoiceId}/boxes`, data),
  updateBox: (boxId, data) => api.put(`/purchases/boxes/${boxId}`, data),
  deleteBox: (boxId) => api.delete(`/purchases/boxes/${boxId}`),
  setBoxItems: (boxId, items) => api.put(`/purchases/boxes/${boxId}/items`, { items }),
  completeBox: (boxId) => api.post(`/purchases/boxes/${boxId}/complete`),
  // Payments
  listPayments: (params) => api.get('/purchases/payments', { params }),
  getPayment: (id) => api.get(`/purchases/payments/${id}`),
  createPayment: (data) => api.post('/purchases/payments', data),
  uploadPaymentImage: (id, formData) =>
    api.post(`/purchases/payments/${id}/images`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
};

export const inventoryAPI = {
  list: (params) => api.get('/inventory', { params }),
  summary: (params) => api.get('/inventory/summary', { params }),
  manualEntry: (data) => api.post('/inventory/manual', data),
  markDamaged: (id, notes) => api.put(`/inventory/${id}/damaged`, { notes }),
};

export const transfersAPI = {
  list: (params) => api.get('/transfers', { params }),
  getById: (id) => api.get(`/transfers/${id}`),
  create: (data) => api.post('/transfers', data),
  ship: (id) => api.post(`/transfers/${id}/ship`),
  receive: (id) => api.post(`/transfers/${id}/receive`),
  cancel: (id) => api.post(`/transfers/${id}/cancel`),
};

export const customersAPI = {
  list: (params) => api.get('/customers', { params }),
  getById: (id) => api.get(`/customers/${id}`),
  create: (data) => api.post('/customers', data),
  update: (id, data) => api.put(`/customers/${id}`, data),
  delete: (id) => api.delete(`/customers/${id}`),
  search: (phone) => api.get('/customers/search', { params: { phone } }),
};

export const salesAPI = {
  list: (params) => api.get('/sales', { params }),
  getById: (id) => api.get(`/sales/${id}`),
  create: (data) => api.post('/sales', data),
  addPayment: (saleId, data) => api.post(`/sales/${saleId}/payments`, data),
  uploadPaymentImage: (saleId, paymentId, formData) =>
    api.post(`/sales/${saleId}/payments/${paymentId}/images`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
};

export const dealersAPI = {
  list: () => api.get('/dealers'),
  getById: (id) => api.get(`/dealers/${id}`),
  create: (data) => api.post('/dealers', data),
  update: (id, data) => api.put(`/dealers/${id}`, data),
  delete: (id) => api.delete(`/dealers/${id}`),
  createInvoice: (data) => api.post('/dealers/invoices', data),
  getInvoice: (invoiceId) => api.get(`/dealers/invoices/${invoiceId}`),
  createPayment: (data) => api.post('/dealers/payments', data),
};

export const returnsAPI = {
  createCustomerReturn: (data) => api.post('/returns/customer', data),
  createSupplierReturn: (data) => api.post('/returns/supplier', data),
};

export const notificationsAPI = {
  getUnread: () => api.get('/notifications'),
  markAsRead: (id) => api.put(`/notifications/${id}/read`),
};

export const expensesAPI = {
  list: (params) => api.get('/expenses', { params }),
  getCategories: () => api.get('/expenses/categories'),
  create: (data) => api.post('/expenses', data),
  update: (id, data) => api.put(`/expenses/${id}`, data),
  delete: (id) => api.delete(`/expenses/${id}`),
  summary: (params) => api.get('/expenses/summary', { params }),
};

export const reportsAPI = {
  dashboard: (params) => api.get('/reports/dashboard', { params }),
  dashboardHome: (params) => api.get('/reports/dashboard-home', { params }),
  dashboardAdmin: (params) => api.get('/reports/dashboard-admin', { params }),
  salesAnalytics: (params) => api.get('/reports/sales-analytics', { params }),
  productAnalytics: (params) => api.get('/reports/product-analytics', { params }),
  inventoryAnalytics: (params) => api.get('/reports/inventory-analytics', { params }),
  financial: (params) => api.get('/reports/financial', { params }),
  customerAnalytics: (params) => api.get('/reports/customer-analytics', { params }),
  employeeAnalytics: (params) => api.get('/reports/employee-analytics', { params }),
};

export const auditLogAPI = {
  list: (params) => api.get('/audit-log', { params }),
  log: (data) => api.post('/audit-log/log', data),
  clear: () => api.delete('/audit-log/clear'),
};
