const { Router } = require('express');
const controller = require('./shifts.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { openSchema, closeSchema, movementSchema, listSchema, recountSchema } = require('./shifts.validation');

const router = Router();
router.use(auth);

// Opening and closing the till is the cashier's job, so it rides with `shifts`.
const canRunShift = permission('shifts', 'write');
const canRead = permission('shifts', 'read');
// Taking money OUT is the owner's, and is deliberately a different permission: anyone
// who can close a drawer should not thereby be able to empty one.
const canMoveCash = permission('cash_drawer', 'write');

// Fixed paths before /:id.
router.get('/current', canRead, controller.current);
router.get('/unassigned-cash', canRead, controller.unassignedCash);
router.get('/movements', canRead, controller.listMovements);
router.post('/movements', canMoveCash, validate(movementSchema), controller.addMovement);

router.get('/', canRead, validate(listSchema, 'query'), controller.list);
router.post('/', canRunShift, validate(openSchema), controller.open);
router.get('/:id', canRead, controller.getById);
router.get('/:id/position', canRead, controller.position);
router.post('/:id/close', canRunShift, validate(closeSchema), controller.close);
// Reopening undoes a completed count, so it sits with the money permission.
router.post('/:id/reopen', canMoveCash, controller.reopen);
// Correcting a miscount is a smaller act than reopening for trading, so it sits with
// the till permission rather than the cash-drawer one — the person who counted wrong
// is the person who should be able to say so.
router.post('/:id/recount', canRunShift, validate(recountSchema), controller.recount);

module.exports = router;
