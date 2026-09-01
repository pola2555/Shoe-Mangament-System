const { Router } = require('express');
const controller = require('./expenses.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createUpload } = require('../../middleware/upload');
const {
  listExpensesSchema,
  createExpenseSchema,
  updateExpenseSchema,
  createCategorySchema,
  updateCategorySchema,
  createRecurringSchema,
  updateRecurringSchema,
  postRecurringSchema,
  setBudgetSchema,
} = require('./expenses.validation');

const router = Router();
router.use(auth);

const upload = createUpload('expenses');

/**
 * Reads use `expenses:read` throughout, including the category list — the add-expense
 * form needs it, and requiring a separate code for that would 403 every existing user
 * until an admin re-granted it (which is exactly what once broke the dashboard).
 *
 * Shaping the catalogue — categories, recurring templates, budgets — uses
 * `expense_categories:write`. That permission row already exists; it had simply never
 * been wired to anything.
 */
const canRead = permission('expenses', 'read');
const canWrite = permission('expenses', 'write');
const canSetup = permission('expense_categories', 'write');

// --- categories (specific paths before /:id so they are not swallowed) ---
router.get('/categories', canRead, controller.getCategories);
router.post('/categories', canSetup, validate(createCategorySchema), controller.createCategory);
router.put('/categories/:id', canSetup, validate(updateCategorySchema), controller.updateCategory);
router.patch('/categories/:id/toggle-active', canSetup, controller.toggleCategoryActive);
router.delete('/categories/:id', canSetup, controller.deleteCategory);

// --- recurring ---
router.get('/recurring', canRead, controller.listRecurring);
router.post('/recurring', canSetup, validate(createRecurringSchema), controller.createRecurring);
router.put('/recurring/:id', canSetup, validate(updateRecurringSchema), controller.updateRecurring);
router.delete('/recurring/:id', canSetup, controller.deleteRecurring);
// Posting an occurrence is ordinary expense entry, not catalogue setup.
router.post('/recurring/:id/post', canWrite, validate(postRecurringSchema), controller.postRecurring);

// --- budgets ---
router.get('/budgets', canRead, controller.budgets);
router.put('/budgets', canSetup, validate(setBudgetSchema), controller.setBudget);

// --- reporting ---
router.get('/summary', canRead, controller.summary);
router.get('/monthly-trend', canRead, controller.monthlyTrend);

// --- expenses ---
router.get('/', canRead, validate(listExpensesSchema, 'query'), controller.list);
router.post('/', canWrite, validate(createExpenseSchema), controller.create);
router.get('/:id', canRead, controller.getById);
router.put('/:id', canWrite, validate(updateExpenseSchema), controller.update);
router.delete('/:id', canWrite, controller.delete);

// --- receipts ---
router.get('/:id/receipts', canRead, controller.listReceipts);
router.post('/:id/receipts', canWrite, upload.single('image'), controller.uploadReceipt);
router.delete('/:id/receipts/:imageId', canWrite, controller.deleteReceipt);

module.exports = router;
