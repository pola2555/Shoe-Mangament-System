/**
 * WHAT A PERSON CAN BE TOLD ABOUT.
 *
 * Every notification the system raises carries a `type`. Until now that type was only
 * ever used to pick an icon: everyone with a reason to receive a notification received
 * it, and there was no way to say "tell the owner about staff expenses but not about
 * every cost correction".
 *
 * This is the list of topics, and it is the single source of truth for three things:
 * which toggles the admin sees, what the default is for a person nobody has configured,
 * and where clicking the notification takes you.
 *
 * FILTERED ON READ, NOT ON WRITE
 *
 * A turned-off topic still gets written; it is hidden when the bell is read. That means
 * turning a topic back on shows what was missed rather than a gap, and it needs no
 * change at the six places that insert notifications — including any seventh added
 * later, which is exactly the kind of thing that gets forgotten.
 *
 * `route` is a frontend path built from the notification's own `reference_id`. A
 * notification that cannot say where to go is worse than useless: it reports a problem
 * and leaves the reader hunting for it.
 */

const NOTIFICATION_TYPES = [
  {
    code: 'staff_expense',
    category: 'finance',
    // Money left the drawer and the owner did not do it. This is the one nobody
    // should be able to miss by accident, so it defaults on and is marked important.
    defaultOn: true,
    important: true,
    route: (n) => (n.reference_id ? `/expenses?highlight=${n.reference_id}` : '/expenses'),
  },
  {
    code: 'discount_request',
    category: 'sales',
    defaultOn: true,
    important: true,
    route: (n) => (n.reference_id ? `/approvals?request=${n.reference_id}` : '/approvals'),
  },
  {
    code: 'discount_decision',
    category: 'sales',
    defaultOn: true,
    route: (n) => (n.reference_id ? `/pos?discount=${n.reference_id}` : '/pos'),
  },
  {
    code: 'credit_request',
    category: 'sales',
    defaultOn: true,
    important: true,
    route: (n) => (n.reference_id ? `/approvals?tab=credit&request=${n.reference_id}` : '/approvals?tab=credit'),
  },
  {
    code: 'credit_decision',
    category: 'sales',
    defaultOn: true,
    route: (n) => (n.reference_id ? `/pos?credit=${n.reference_id}` : '/pos'),
  },
  {
    code: 'price_update',
    category: 'purchasing',
    defaultOn: true,
    route: (n) => (n.reference_id ? `/products/${n.reference_id}` : '/products'),
  },
  {
    code: 'cost_corrected',
    category: 'purchasing',
    defaultOn: true,
    route: (n) => (n.reference_id
      ? `/stock-intakes?tab=corrections&batch=${n.reference_id}`
      : '/stock-intakes?tab=corrections'),
  },
  {
    code: 'shift_difference',
    category: 'finance',
    defaultOn: true,
    important: true,
    route: (n) => (n.reference_id ? `/shifts?shift=${n.reference_id}` : '/shifts'),
  },
  {
    code: 'stock_count_posted',
    category: 'inventory',
    defaultOn: true,
    route: (n) => (n.reference_id ? `/stock-counts?sheet=${n.reference_id}` : '/stock-counts'),
  },
  {
    code: 'low_stock',
    category: 'inventory',
    // Off by default: it fires per product and would bury everything else. A shop that
    // wants it turns it on deliberately.
    defaultOn: false,
    route: (n) => (n.reference_id ? `/products/${n.reference_id}` : '/reports?tab=reorder'),
  },
  {
    code: 'transfer_incoming',
    category: 'inventory',
    defaultOn: true,
    route: (n) => (n.reference_id ? `/transfers?transfer=${n.reference_id}` : '/transfers'),
  },
  {
    code: 'loan_due',
    category: 'finance',
    defaultOn: true,
    route: (n) => (n.reference_id ? `/loans?loan=${n.reference_id}` : '/loans'),
  },
  {
    code: 'supplier_payment',
    category: 'purchasing',
    defaultOn: true,
    route: (n) => (n.reference_id ? `/suppliers/${n.reference_id}` : '/suppliers'),
  },
];

const BY_CODE = new Map(NOTIFICATION_TYPES.map((t) => [t.code, t]));

const ALL_CODES = NOTIFICATION_TYPES.map((t) => t.code);

/** Topics that are on for somebody nobody has configured. */
const DEFAULT_ON = NOTIFICATION_TYPES.filter((t) => t.defaultOn).map((t) => t.code);

/**
 * Which topics this user should NOT see, given their stored choices.
 *
 * A stored row always wins. Absence means the registry default, so adding a new topic
 * switches it on for everyone who wants it without a backfill, and adding one that
 * defaults off stays quiet until somebody asks for it.
 *
 * @param {Array<{type: string, enabled: boolean}>} rows
 * @returns {string[]} type codes to hide
 */
function disabledTypesFor(rows = []) {
  const chosen = new Map(rows.map((r) => [r.type, r.enabled]));
  return NOTIFICATION_TYPES
    .filter((t) => (chosen.has(t.code) ? !chosen.get(t.code) : !t.defaultOn))
    .map((t) => t.code);
}

module.exports = { NOTIFICATION_TYPES, BY_CODE, ALL_CODES, DEFAULT_ON, disabledTypesFor };
