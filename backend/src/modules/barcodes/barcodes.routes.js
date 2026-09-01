const { Router } = require('express');
const controller = require('./barcodes.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  assignSchema,
  linkSchema,
  lookupSchema,
  labelsSchema,
} = require('./barcodes.validation');

const router = Router();
router.use(auth);

// POS scan resolution. The controller re-derives store scope from req.user, so a
// client-supplied store_id is checked against the caller's assignments rather than
// trusted.
router.get('/lookup', permission('pos', 'read'), validate(lookupSchema, 'query'), controller.lookup);

// Label payloads for printing.
router.get('/labels', permission('barcodes', 'read'), validate(labelsSchema, 'query'), controller.labels);

// Minting and manufacturer links.
router.post('/assign', permission('barcodes', 'write'), validate(assignSchema), controller.assign);
router.post('/link', permission('barcodes', 'write'), validate(linkSchema), controller.link);
router.delete('/:variantId', permission('barcodes', 'write'), controller.clear);

module.exports = router;
