const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const env = require('./config/env');
const db = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const activityLogger = require('./middleware/activityLogger');
const { startRetentionJob } = require('./utils/retention');

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
const loanRoutes = require('./modules/loans/loans.routes');
const barcodeRoutes = require('./modules/barcodes/barcodes.routes');
const productCategoryRoutes = require('./modules/product-categories/product-categories.routes');
const sizeScaleRoutes = require('./modules/product-categories/size-scales.routes');
const colorPresetRoutes = require('./modules/product-categories/color-presets.routes');

const app = express();

// Trust first proxy (Nginx)
app.set('trust proxy', 1);

// --- Global Rate Limiting ---
const rateLimit = require('express-rate-limit');
// The budget is per-IP, and a shop's tills all share one public address behind NAT.
// Three or four terminals plus the app's own polling can reach 200/min on a busy
// afternoon, so this is configurable rather than hard-coded.
const API_RATE_MAX = Number(process.env.API_RATE_MAX) || 200;

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: API_RATE_MAX,
  message: { success: false, message: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// --- Core Middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // Inter is self-hosted (frontend/src/styles/fonts.css); the Google hosts were
      // dropped because they proved reachable only intermittently and a blocked font
      // stylesheet froze the whole app for the connection timeout.
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors({                                      // CORS — restrict to frontend origin
  origin: env.cors.origin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));
app.use(express.json({ limit: '10mb' }));           // JSON body parser
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // URL-encoded parser
// 'dev' is colorised and verbose — fine locally, wasteful per-request work and log
// volume in production, where 'combined' is the useful format.
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

// Serve uploaded files statically (local storage only) with security headers
if (env.storage.type === 'local') {
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), {
    maxAge: '30d',
    immutable: true,
    setHeaders: (res) => {
      res.set('X-Content-Type-Options', 'nosniff');
    },
  }));
}

// --- Activity Logging (intercepts all write operations) ---
app.use(activityLogger);

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
// Catalogue reference data. Mounted beside products rather than under it: the POS
// and inventory filters need the category list without touching product endpoints.
app.use('/api/product-categories', productCategoryRoutes);
app.use('/api/size-scales', sizeScaleRoutes);
app.use('/api/color-presets', colorPresetRoutes);
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
app.use('/api/loans', loanRoutes);
app.use('/api/barcodes', barcodeRoutes);

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
const server = app.listen(env.port, () => {
  console.log(`\n🚀 Shoe ERP Backend running on port ${env.port}`);
  console.log(`   Environment: ${env.nodeEnv}`);
  console.log(`   Health: http://localhost:${env.port}/api/health\n`);

  // Periodic pruning of activity_log / refresh_tokens / notifications, which
  // otherwise grow without bound.
  startRetentionJob();
});

// Close idle connections rather than letting sockets accumulate.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Graceful shutdown so pm2 restarts don't sever in-flight requests or leave
// database connections dangling.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n${signal} received — shutting down gracefully`);
    server.close(async () => {
      try { await db.destroy(); } catch { /* already closed */ }
      process.exit(0);
    });

    // server.close() waits for every open socket, and keep-alive holds idle ones for
    // 65s — so without this the shutdown would almost always hit the watchdog below
    // and exit(1) without closing the pool, on every single pm2 reload.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    // Last resort if an in-flight request refuses to finish.
    setTimeout(() => {
      console.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000).unref();
  });
}

module.exports = app;
