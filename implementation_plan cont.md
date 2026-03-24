# Phase 10 — Invoice Editing & Image Upload

## Goal Description
The user needs the ability to edit an existing purchase invoice's details (specifically the `total_amount` and `invoice_date`, which are currently read-only after creation) and optionally upload an image of the physical invoice document.

## User Review Required
None.

## Proposed Changes

### Database
- Create a new migration script to add `invoice_image_url` (text, nullable) and `discount_amount` (decimal, default 0) to the `purchase_invoices` table.

### Backend API: Invoice Discounts logic
#### [MODIFY] [backend/src/modules/suppliers/suppliers.service.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/suppliers/suppliers.service.js)
- Update [list](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/api/index.js#125-126) method to [sum(total_amount - COALESCE(discount_amount, 0))](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/inventory/inventory.service.js#69-137) for `invoiceSum`.
- Update [getById](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/api/index.js#29-30) method to subtract `discount_amount` from `total_amount` when calculating `invoiceSum`.

#### [MODIFY] [backend/src/modules/purchases/purchases.service.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/purchases/purchases.service.js)
- Update [createInvoice](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/api/index.js#139-140) so that `invoiceTotal` = `total_amount - discount_amount`. This ensures payments are allocated correctly.
- Update [updateInvoice](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/purchases/purchases.service.js#189-214) so that the `status` calculation uses `netTotal` (`total_amount - discount_amount`).

### Backend API: Invoice Editing
#### [MODIFY] [backend/src/modules/purchases/purchases.routes.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/purchases/purchases.routes.js)
- Add `PUT /:id` endpoint for updating `total_amount`, `discount_amount`, `invoice_date`, and `notes`.
- Add `POST /:id/image` endpoint using `multer` for uploading the invoice image.

#### [MODIFY] [backend/src/modules/purchases/purchases.validation.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/purchases/purchases.validation.js)
- Add `updatePurchaseSchema` to validate `total_amount` (number), `discount_amount` (number), `invoice_date` (date), and `notes`.

#### [MODIFY] [backend/src/modules/purchases/purchases.controller.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/purchases/purchases.controller.js)
- Implement [update](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/api/index.js#14-15) handler.
- Implement [uploadInvoiceImage](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/purchases/purchases.controller.js#90-105) handler.

### Frontend
#### [MODIFY] [frontend/src/pages/purchases/PurchaseDetailPage.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/pages/purchases/PurchaseDetailPage.jsx)
- Add an "✎ Edit Invoice" button in the Invoice Details sidebar.
- Create an `EditInvoiceModal` component.
  - Form fields: Invoice Date, Total Amount, Discount Amount, Notes, Invoice Image (file input).
  - Handle form submission by calling the necessary APIs and refreshing the data.
- Update `owed` calculation to subtract `discount_amount`.

#### [MODIFY] [frontend/src/pages/purchases/PurchasesPage.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/pages/purchases/PurchasesPage.jsx)
- Update `remaining` calculation in the list to subtract `discount_amount`.

### Frontend: Image Viewer
#### [NEW] [frontend/src/components/common/ImageViewerModal.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/components/common/ImageViewerModal.jsx)
- Create a generic full-screen overlay component.
- Implement zoom in/out via CSS `transform: scale()`.
- Implement panning via mouse drag events updating `translate()`.
- Add a "Download" button (`<a href="..." download>` tag).
- Integrate it into [PurchaseDetailPage.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/pages/purchases/PurchaseDetailPage.jsx) to open when an image card or document link is clicked.

### Frontend: Smart Variant Generator
#### [MODIFY] [frontend/src/pages/products/ProductDetailPage.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/pages/products/ProductDetailPage.jsx)
- Introduce a "Smart Generator" UI in the Variants tab alongside the single variant form.
- Allow users to select multiple colors from the product's color list.
- Allow users to define a size range (e.g. EU Start: 38, EU End: 45).
- "Generate Preview" button populates a grid of editable rows (Color, EU Size, US Size, UK Size, CM).
- Allow users to individually edit or delete specific variants in the preview table before committing.
- "Save Variants" button groups by `product_color_id` and calls `productsAPI.bulkCreateVariants` for each group concurrently.

### Frontend: Editing Existing Variants
#### [MODIFY] [frontend/src/pages/products/ProductDetailPage.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/pages/products/ProductDetailPage.jsx)
- Introduce `editingVariantId` and `editVariantForm` state.
- Update the variants table rendering so rows can switch to an "Edit mode".
- When in edit mode, display input fields for US, UK, CM sizes and a toggle for `is_active`.
- Add a "Save" button to the row that fires `productsAPI.updateVariant` with the modified data.

### Backend: Sales Refund Tracking
#### [NEW DB MIGRATION]
- Create `add_refunded_amount_to_sales` to add `t.decimal('refunded_amount', 10, 2).defaultTo(0)` to the `sales` table.
#### [MODIFY] [backend/src/modules/returns/returns.service.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/returns/returns.service.js)
- In [createCustomerReturn](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/returns/returns.service.js#6-68), add a query `trx('sales').where('id', data.sale_id).increment('refunded_amount', totalRefund)` to persist the financial impact of the return onto the parent sale.
#### [MODIFY] [backend/src/modules/sales/sales.service.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/sales/sales.service.js)
- In [getById](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/api/index.js#29-30), attach a `leftJoin` to `customer_return_items` based on `sale_items.id`. Select a boolean alias `is_returned` if the `customer_return_items.id` exists.

### Frontend: Sales History Refund Tracking
#### [MODIFY] `frontend/src/pages/sales/SalesHistoryPage.jsx`
- In the main sales table and cards, display `refunded_amount` (in red, e.g. `-250 EGP`) if it is greater than 0.
- Show the `Net Sale` (`final_amount - refunded_amount`).
- In the Sale Details view (when a row is clicked), iterate over the items. If `is_returned` is true, wrap the item row in a subtle red background and add a "Returned" pill badge so the manager knows exactly which items the customer gave back.

### Backend: Advanced Dashboard Analytics
#### [MODIFY] [backend/src/modules/reports/reports.service.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/reports/reports.service.js)
- Update [getDashboardStats](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/reports/reports.service.js#7-192) to accept `startDate`, `endDate`, `store_id`, and `limit` query parameters. Ensure ALL aggregations are filtered by these dynamically.
- Implement robust analytical queries:
  - **Dynamic Top Metrics**: Net Sales, Clear Profit, Items Sold, Items Returned, Net Margin (%), Average Order Value (AOV).
  - **Financials**: Current Inventory Valuation (Total Value of Stock).
  - `sales_trend`: Group sales by day/month to plot Revenue, Profit, and Expenses over time.
  - `sales_by_payment_method`: Break down revenue by Cash, Card, InstaPay, etc.
  - `top_products`: Group by `product_id` linking variant data to find Top X bestsellers by Quantity and Revenue.
  - `store_performance`: If looking at "All Stores", return revenue generated per store for a pie chart.
  - `top_customers`: Top X customers by total spending in the selected period.
  - `returned_products`: Products with the highest return frequencies (to identify quality issues).
  - `inventory_alerts`: Top X products currently lowest in stock in the selected store(s).

### Frontend: Advanced Analytics Dashboard Redesign
#### [MODIFY] [package.json](file:///d:/freelancing/Shoe%20Mangament%20System/backend/package.json) & Frontend Code
- Verify/install `recharts` via `npm install recharts` for beautiful SVG-based data visualization.
#### [MODIFY] [frontend/src/pages/dashboard/DashboardPage.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/pages/dashboard/DashboardPage.jsx)
- Replace the existing simple cards array with a sophisticated layout.
- Create a **Global Control Ribbon** at the top:
  - `Store Selector` (All Stores or specific branch)
  - `Time Horizon` (Today, This Week, This Month, This Year, All Time, Custom Dates)
  - `Top X Limit` (5, 10, 20)
- **Top Row (Financial Health)**: Dynamic Metric Cards (Net Sales, Profit, Net Margin %, Average Order Value, Inventory Value, Owed Suppliers).
- **Middle Row (Charts)**: 
  - `Sales & Profit Trend` (Line/Area Chart)
  - `Store Performance` (Pie Chart) & `Payment Methods` (Pie Chart).
- **Bottom Row (Leaderboards)**:
  - `Top X Products` table (ranking by qty/revenue)
  - `Top X Customers` table
  - `High Return Alerts` & `Low Stock Alerts`

## Phase 18 — Dynamic Cost Updates & Notifications
### Goal
When a purchase invoice introduces a box of items where the calculated cost-per-item differs from the product's established `net_price`, automatically update the `net_price` and generate a persistent system notification so management is reminded to adjust the selling price.

### Backend Strategy
- **Migration**: Create a `notifications` table ([id](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/components/layout/Sidebar.jsx#67-142) UUID, `type` VARCHAR, `title` VARCHAR, `message` TEXT, `reference_id` UUID (nullable), `is_read` BOOLEAN DEFAULT FALSE, `created_at` TIMESTAMP).
- **Service**: In [backend/src/modules/purchases/purchases.service.js](file:///d:/freelancing/Shoe%20Mangament%20System/backend/src/modules/purchases/purchases.service.js) (specifically within `_processInvoiceBoxes`), after determining the `unitCost` (`box.box_cost / Object.values(box.variants).reduce(...)`), compare it to the DB's `products.net_price`. 
- **Trigger**: If `unitCost !== net_price`, update `products.net_price = unitCost` AND insert a notification record with `reference_id = product_id`.
- **Isolation**: Because the dashboard and historical sales rely on physical `inventory_items.cost` and `sale_items.cost_at_sale`, updating `products.net_price` acts purely as a forward-facing benchmark. Old metrics remain strictly perfectly untouched.

### Frontend Strategy
- **Notification Manager**: Add a Bell icon to [Sidebar.jsx](file:///d:/freelancing/Shoe%20Mangament%20System/frontend/src/components/layout/Sidebar.jsx) (with a red unread count badge).
- **Panel**: Clicking the bell opens a popover or modal displaying unread alerts (e.g., *"Price Update: [SKU] cost changed from 500 to 550. Re-evaluate selling bounds."*).
- **Dismissal & Routing**: Provide a click action for the notification. Clicking it triggers a `PUT /api/notifications/:id/read` array update, and uses `navigate('/products/' + reference_id)` to take the user directly to the affected product's details page.

## Verification Plan
### Automated Tests
- Run `npm run dev` to ensure no syntax errors.
- Run DB migrations successfully.

### Manual Verification
- Navigate to a Purchase Detail page.
- Click Edit Invoice, change the amount, date, and select an image file.
- Verify the DB updates properly, visually check the frontend for the image, and verify the Supplier Balance adjusts correctly based on the new total amount.
