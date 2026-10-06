const { Router } = require('express');
const controller = require('./print-queue.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  listSchema,
  summarySchema,
  addSchema,
  fromSourceSchema,
  sourceLinesSchema,
  updateSchema,
  markPrintedSchema,
  labelsSchema,
  labelsBodySchema,
  clearSchema,
} = require('./print-queue.validation');

const router = Router();
router.use(auth);

/**
 * `print_queue` is its own permission rather than a corner of `barcodes`.
 *
 * Printing labels for the product on your screen and keeping the shop's standing list
 * of labels owed are different jobs done by different people: the first belongs to
 * whoever is at the product, the second to whoever has the printer. A shop that wants
 * one person doing the printing grants this to them alone, and the page disappears for
 * everybody else — which is the whole reason it is separable.
 *
 * Reading is deliberately NOT tied to `barcodes:read`. The queue reads its own label
 * payloads through /labels for exactly that reason: somebody who runs the printer needs
 * no ability to mint barcodes, and somebody who mints barcodes need not hold the queue.
 */
const canRead = permission('print_queue', 'read');
const canWrite = permission('print_queue', 'write');

// Fixed paths before /:id, or `summary` is read as a queue row id. This module has no
// GET /:id, but the DELETE and POST ones below do collide, and the order is the guard.
router.get('/summary', canRead, validate(summarySchema, 'query'), controller.summary);
router.get('/labels', canRead, validate(labelsSchema, 'query'), controller.labels);
/**
 * The same read, as a POST, because the selection does not always fit in a URL.
 *
 * "Print everything" on a busy queue sends every row id, and an id is 37 characters.
 * Three hundred rows is an 11 KB query string — past nginx's default 8 KB request line,
 * where it comes back as a 414 with nothing on screen to explain it. A body has no such
 * limit. Gated on READ, because that is what it is: nothing is written.
 */
router.post('/labels', canRead, validate(labelsBodySchema), controller.labels);
router.get('/source-lines', canRead, validate(sourceLinesSchema, 'query'), controller.sourceLines);
router.post('/from-source', canWrite, validate(fromSourceSchema), controller.addFromSource);
router.post('/mark-printed', canWrite, validate(markPrintedSchema), controller.markPrinted);
router.post('/clear', canWrite, validate(clearSchema), controller.clear);

router.get('/', canRead, validate(listSchema, 'query'), controller.list);
router.post('/', canWrite, validate(addSchema), controller.add);
router.patch('/:id', canWrite, validate(updateSchema), controller.update);
router.post('/:id/requeue', canWrite, controller.requeue);
router.delete('/:id', canWrite, controller.remove);

module.exports = router;
