/**
 * Day 26 — the browser's copy of the order lifecycle.
 *
 * `sick-fits/backend/lib/orderStatus.ts` is the source of truth: it builds the
 * admin select, decides every legal move and refuses the rest. The storefront
 * needs the same words and the same happy-path order to draw an order's progress,
 * and it cannot import a TypeScript file from the backend package — so this file
 * is a deliberate mirror.
 *
 * A mirror nobody checks is a copy that drifts. `__tests__/orderStatusMirror.test.js`
 * reads the backend file off disk and fails the moment the two disagree, which is
 * the same pattern `checkoutMessagesMirror.test.js` and `cartRulesMirror.test.js`
 * already use. Nothing here decides anything: the browser may only *display* a
 * status, never choose one.
 */

export const ORDER_STATUSES = [
  'CREATED',
  'PAID',
  'FULFILLED',
  'DELIVERED',
  'CANCELLED'
];

export const STATUS_LABELS = {
  CREATED: 'Created',
  PAID: 'Paid',
  FULFILLED: 'Fulfilled',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled'
};

/** The normal forward path, in order. Terminal states are not on it. */
export const STATUS_FLOW = ['CREATED', 'PAID', 'FULFILLED', 'DELIVERED'];

export const STATUS_TRANSITIONS = {
  CREATED: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  FULFILLED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: []
};

export function isOrderStatus(value) {
  return typeof value === 'string' && ORDER_STATUSES.includes(value);
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || 'Status unknown';
}

export function nextStatuses(status) {
  return isOrderStatus(status) ? STATUS_TRANSITIONS[status].slice() : [];
}

export function isTerminal(status) {
  return isOrderStatus(status) && STATUS_TRANSITIONS[status].length === 0;
}

/**
 * How far along the happy path an order is, 0–100. A cancelled order is not on
 * the path at all, so it reports 0 — the UI shows the cancelled state instead of
 * a progress bar, rather than pretending it is "almost Delivered".
 */
export function progressPercent(status) {
  const index = STATUS_FLOW.indexOf(status);
  if (index === -1) return 0;
  return Math.round((index / (STATUS_FLOW.length - 1)) * 100);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
];

/**
 * A stable, server-independent date: "18 Oct 2026". Rendered in UTC on purpose
 * so a customer in Lagos and a test runner in CI read the same day for the same
 * timestamp.
 */
export function formatOrderDate(value) {
  if (!value) return 'Date unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unknown';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
