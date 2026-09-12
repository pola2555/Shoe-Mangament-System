/**
 * WHERE A NOTIFICATION TAKES YOU.
 *
 * Clicking a notification used to mark it read, close the panel, and — unless it
 * happened to be a `price_update` — leave you exactly where you were. So the one thing
 * a notification is for, getting you to the thing it is about, worked for one type out
 * of thirteen. Being told "Karim recorded an expense of 240 EGP" and then having to go
 * and find it is worse than not being told.
 *
 * Mirrors backend/src/utils/notificationTypes.js. The two are checked against each
 * other by `npm run check:audit`, because a type that exists on one side and not the
 * other is a notification that either cannot be switched off or cannot be followed.
 */

const ROUTES = {
  staff_expense: (n) => (n.reference_id ? `/expenses?highlight=${n.reference_id}` : '/expenses'),
  discount_request: (n) => (n.reference_id ? `/approvals?request=${n.reference_id}` : '/approvals'),
  discount_decision: (n) => (n.reference_id ? `/pos?discount=${n.reference_id}` : '/pos'),
  credit_request: (n) => (n.reference_id ? `/approvals?tab=credit&request=${n.reference_id}` : '/approvals?tab=credit'),
  credit_decision: (n) => (n.reference_id ? `/pos?credit=${n.reference_id}` : '/pos'),
  price_update: (n) => (n.reference_id ? `/products/${n.reference_id}` : '/products'),
  cost_corrected: (n) => (n.reference_id
    ? `/stock-intakes?tab=corrections&batch=${n.reference_id}`
    : '/stock-intakes?tab=corrections'),
  shift_difference: (n) => (n.reference_id ? `/shifts?shift=${n.reference_id}` : '/shifts'),
  stock_count_posted: (n) => (n.reference_id ? `/stock-counts?sheet=${n.reference_id}` : '/stock-counts'),
  low_stock: (n) => (n.reference_id ? `/products/${n.reference_id}` : '/reports?tab=reorder'),
  transfer_incoming: (n) => (n.reference_id ? `/transfers?transfer=${n.reference_id}` : '/transfers'),
  loan_due: (n) => (n.reference_id ? `/loans?loan=${n.reference_id}` : '/loans'),
  supplier_payment: (n) => (n.reference_id ? `/suppliers/${n.reference_id}` : '/suppliers'),
};

/**
 * The path a notification should open, or null when there is genuinely nowhere to go.
 * Returning null rather than a guess matters: navigating somewhere unrelated is more
 * confusing than staying put, which is the failure this replaces.
 */
export function notificationRoute(n) {
  if (!n?.type) return null;
  const fn = ROUTES[n.type];
  return fn ? fn(n) : null;
}

export const NOTIFICATION_ROUTE_TYPES = Object.keys(ROUTES);

export default notificationRoute;
