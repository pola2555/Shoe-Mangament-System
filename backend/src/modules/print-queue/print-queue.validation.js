const Joi = require('joi');

const SOURCE_TYPES = ['purchase_box', 'stock_intake', 'manual'];
const DOCUMENT_SOURCES = ['purchase_box', 'stock_intake'];
const STATUSES = ['pending', 'done', 'cancelled'];

const itemSchema = Joi.object({
  variant_id: Joi.string().uuid().required(),
  // 999 is the same ceiling the print dialog enforces per row. A run bigger than that
  // is a mis-typed number far more often than it is a real order for 1,000 labels.
  quantity: Joi.number().integer().min(0).max(999).required(),
});

const listSchema = Joi.object({
  status: Joi.string().valid(...STATUSES),
  store_id: Joi.string().uuid(),
  source_type: Joi.string().valid(...SOURCE_TYPES),
  search: Joi.string().max(100).allow(''),
  limit: Joi.number().integer().min(1).max(2000),
}).unknown(true);

const summarySchema = Joi.object({
  store_id: Joi.string().uuid(),
}).unknown(true);

const addSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  items: Joi.array().items(itemSchema).min(1).max(2000).required(),
  // A hand-made request cannot claim to be a document: that would let it bypass the
  // "what did this box actually create" check that /from-source applies. Queueing on
  // behalf of a document goes through /from-source, which reads the document itself.
  source_type: Joi.string().valid('manual').default('manual'),
  note: Joi.string().max(500).allow('', null),
});

const fromSourceSchema = Joi.object({
  source_type: Joi.string().valid(...DOCUMENT_SOURCES).required(),
  source_id: Joi.string().uuid().required(),
  // Optional: the dialog lets the operator drop sizes. Absent means "everything this
  // document created". Whatever is sent is still filtered against the document.
  items: Joi.array().items(itemSchema).max(2000),
});

const sourceLinesSchema = Joi.object({
  source_type: Joi.string().valid(...DOCUMENT_SOURCES).required(),
  source_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid(),
}).unknown(true);

const updateSchema = Joi.object({
  quantity: Joi.number().integer().min(1).max(999),
  note: Joi.string().max(500).allow('', null),
}).min(1);

const markPrintedSchema = Joi.object({
  items: Joi.array().items(Joi.object({
    id: Joi.string().uuid().required(),
    // Absent means "all that is left owing on this row", which is the ordinary case.
    // A number is for the roll that ran out halfway.
    quantity: Joi.number().integer().min(0).max(999),
  })).min(1).max(2000).required(),
});

// A comma-joined list is how a query string carries several ids, and the shape is
// checked HERE rather than being left to Postgres: an unvalidated id reaches the driver
// as a cast error, which the error handler can only turn into a generic 400. One
// mistyped character in a fifty-id selection then reads as "printing is broken".
const UUID_LIST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/i;

const labelsSchema = Joi.object({
  ids: Joi.alternatives().try(
    Joi.array().items(Joi.string().uuid()).min(1).max(2000),
    Joi.string().max(80000).pattern(UUID_LIST).messages({
      // Without this the refusal prints the regex, which tells a shopkeeper nothing.
      'string.pattern.base': 'ids must be one or more queue row ids, separated by commas',
    })
  ).required(),
  store_id: Joi.string().uuid(),
}).unknown(true);

/** The body form of the same read. An array, since JSON can carry one properly. */
const labelsBodySchema = Joi.object({
  ids: Joi.array().items(Joi.string().uuid()).min(1).max(2000).required(),
  store_id: Joi.string().uuid(),
});

const clearSchema = Joi.object({
  // Defaults to the printed list. Throwing away work that is still outstanding has to
  // be asked for by name.
  status: Joi.string().valid(...STATUSES).default('done'),
  store_id: Joi.string().uuid(),
});

module.exports = {
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
  SOURCE_TYPES,
  DOCUMENT_SOURCES,
  STATUSES,
};
