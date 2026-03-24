const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const env = require('./config/env');
const errorHandler = require('./middleware/errorHandler');
const activityLogger = require('./middleware/activityLogger');

// Module routes
const authRoutes = require('./modules/auth/auth.routes');
const storeRoutes = require('./modules/stores/stores.routes');
const userRoutes = require('./modules/users/users.routes');
const productRoutes = require('./modules/products/products.routes');
const boxTemplateRoutes = require('./modules/box-templates/box-templates.routes');
const supplierRoutes = require('./modules/suppliers/suppliers.routes');
const purchaseRoutes = require('./modules/purchases/purchases.routes');
const inventoryRoutes = require('./modules/inventory/inventory.routes');
const transferRoutes = require('./modules/transfers/transfers.routes');
const customerRoutes = require('./modules/customers/customers.routes');
const salesRoutes = require('./modules/sales/sales.routes');
const dealerRoutes = require('./modules/dealers/dealers.routes');
const expenseRoutes = require('./modules/expenses/expenses.routes');
const reportRoutes = require('./modules/reports/reports.routes');
const returnsRoutes = require('./modules/returns/returns.routes');
const notificationsRoutes = require('./modules/notifications/notifications.routes');
const auditLogRoutes = require('./modules/audit-log/audit-log.routes');
const backupRoutes = require('./modules/backup/backup.routes');

const app = express();

// --- Core Middleware ---
app.use(helmet());                                  // Security headers
app.use(cors());                                    // CORS for frontend
app.use(express.json({ limit: '10mb' }));           // JSON body parser
app.use(express.urlencoded({ extended: true }));     // URL-encoded parser
app.use(morgan('dev'));                              // Request logging

// Serve uploaded files statically (local storage)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// --- Activity Logging (intercepts all write operations) ---
app.use(activityLogger);

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/box-templates', boxTemplateRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/dealers', dealerRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/backup', backupRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Shoe ERP API is running', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// Global error handler (must be last)
app.use(errorHandler);

// --- Start Server ---
app.listen(env.port, () => {
  console.log(`\n🚀 Shoe ERP Backend running on port ${env.port}`);
  console.log(`   Environment: ${env.nodeEnv}`);
  console.log(`   Health: http://localhost:${env.port}/api/health\n`);
});

module.exports = app;
