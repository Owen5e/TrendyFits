/**
 * Day 26 — the order lifecycle, in one place.
 *
 * WHY THIS FILE EXISTS
 * An order used to be a receipt and nothing more: total, charge id, user, items.
 * Once a real shop starts fulfilling, "where is my order?" is the question
 * customers actually ask, and the honest answer is a state that moves forward
 * under staff control and is visible to the person who paid. So the lifecycle is
 * defined once, here, and every other layer reads it:
 *
 *   - `schemas/Order.ts` builds the admin select field from ORDER_STATUSES and
 *     refuses an illegal move in `hooks.resolveInput`, using assertTransition();
 *   - `frontend/lib/orderStatus.js` is the browser's copy of the labels and the
 *     happy-path order, and `frontend/__tests__/orderStatusMirror.test.js` fails
 *     the moment the two drift apart;
 *   - `docs/ORDER-STATUS.md` is the table a human reads.
 *
 * THE RULE
 * Status only ever moves forward, and only along a legal edge:
 *
 *      CREATED ──▶ PAID ──▶ FULFILLED ──▶ DELIVERED
 *         │          │
 *         └──────────┴──▶ CANCELLED
 *
 * `DELIVERED` and `CANCELLED` are terminal: there is no "un-cancel" through the
 * API, because a customer has been emailed about it and a refund is a separate
 * financial act, not a status edit. A backwards move is not a correction — it is
 * a second, contradictory email.
 *
 * A no-op (`PAID → PAID`) is allowed so that re-saving an admin form, or a retry
 * that re-sends the same status, does not fail for no reason. It is not a
 * transition: it does not restamp `statusChangedAt`.
 */

export const ORDER_STATUSES = [
  'CREATED',
  'PAID',
  'FULFILLED',
  'DELIVERED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The words a customer and a staff member both read. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  CREATED: 'Created',
  PAID: 'Paid',
  FULFILLED: 'Fulfilled',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

/**
 * The normal forward path, used by the storefront to draw progress. Terminal
 * states are not on it: a cancelled order has no progress to show.
 */
export const STATUS_FLOW: OrderStatus[] = [
  'CREATED',
  'PAID',
  'FULFILLED',
  'DELIVERED',
];

/** Every legal edge. Anything not listed is refused. */
export const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  FULFILLED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export class OrderStatusError extends Error {
  code: string;

  constructor(message: string, code = 'invalid_status_transition') {
    super(message);
    this.name = 'OrderStatusError';
    this.code = code;
  }
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === 'string' &&
    (ORDER_STATUSES as readonly string[]).includes(value)
  );
}

/** Statuses a staff member may move this order to. Empty for terminal states. */
export function nextStatuses(from: string): OrderStatus[] {
  if (!isOrderStatus(from)) {
    return [];
  }
  return STATUS_TRANSITIONS[from].slice();
}

/**
 * Can `from` legally become `to`? A same-status save is allowed (nothing moves),
 * so this is true for `PAID → PAID` as well.
 */
export function canTransition(from: string, to: string): boolean {
  if (!isOrderStatus(from) || !isOrderStatus(to)) {
    return false;
  }
  if (from === to) {
    return true;
  }
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The sentence a staff member sees in the admin UI when they have picked a move
 * the shop does not allow. It names both ends and the legal alternatives, because
 * "invalid input" teaches nobody anything.
 */
export function transitionRefusal(from: string, to: string): string {
  if (!isOrderStatus(from)) {
    throw new OrderStatusError(
      `This order has an unrecognised status (${String(from)}), so it cannot be moved. Fix the record first.`,
      'unknown_current_status',
    );
  }
  if (!isOrderStatus(to)) {
    throw new OrderStatusError(
      `"${String(to)}" is not an order status. Use one of: ${ORDER_STATUSES.join(', ')}.`,
      'unknown_target_status',
    );
  }
  const allowed = STATUS_TRANSITIONS[from];
  if (allowed.length === 0) {
    return `An order that is ${STATUS_LABELS[from]} cannot be moved again — ${STATUS_LABELS[from]} is a final state.`;
  }
  return `An order cannot go from ${STATUS_LABELS[from]} to ${STATUS_LABELS[to]}. The next step from ${STATUS_LABELS[from]} is ${allowed
    .map((status) => STATUS_LABELS[status])
    .join(' or ')}.`;
}

/** Throws OrderStatusError unless the move is legal. Returns the target status. */
export function assertTransition(from: string, to: string): OrderStatus {
  if (!canTransition(from, to)) {
    throw new OrderStatusError(transitionRefusal(from, to));
  }
  return to as OrderStatus;
}

export interface StatusInputArgs {
  operation: 'create' | 'update';
  existingItem?: { status?: string; statusChangedAt?: string } | null;
  resolvedData: Record<string, any>;
  /** `context.session` from Keystone. */
  session?: any;
}

/**
 * `true` when the caller may move an order: the role carries canManageOrders.
 * Keystone's field-level access already blocks a customer's write; this is the
 * belt to that braces, because a hook must not depend on the layer above it.
 */
export function isOrderStaff(session?: any): boolean {
  return Boolean(session?.data?.role?.canManageOrders);
}

/**
 * The list's `hooks.resolveInput`: validates the status move and stamps
 * `statusChangedAt` when the status actually changes. Returns the data to write.
 *
 * Called with a real Keystone context in production and with a plain object in
 * `test/order-status.test.js`, which is why it takes `session` rather than
 * `context`.
 */
export function resolveStatusInput({
  operation,
  existingItem,
  resolvedData,
  session,
}: StatusInputArgs): Record<string, any> {
  const data = { ...(resolvedData || {}) };
  const requested = data.status;

  if (operation === 'create') {
    // A new order starts at CREATED. A staff member may create one further
    // along (a phone order taken after payment), but never in an invented
    // state, and never without the stamp that explains when it moved.
    const status = requested === undefined || requested === null ? 'CREATED' : requested;
    if (!isOrderStatus(status)) {
      throw new OrderStatusError(
        `"${String(status)}" is not an order status. Use one of: ${ORDER_STATUSES.join(', ')}.`,
        'unknown_target_status',
      );
    }
    if (status !== 'CREATED' && !isOrderStaff(session)) {
      throw new OrderStatusError(
        'Only staff can create an order in a status other than Created.',
        'status_change_forbidden',
      );
    }
    data.status = status;
    data.statusChangedAt = new Date().toISOString();
    return data;
  }

  // update
  if (requested === undefined || requested === null) {
    // Nothing about the status was sent: leave both fields exactly as they are.
    delete data.status;
    delete data.statusChangedAt;
    return data;
  }

  const current = existingItem?.status || 'CREATED';
  if (!isOrderStaff(session)) {
    // Field-level access should already have removed this from the input. If it
    // ever does not, the write still does not happen.
    throw new OrderStatusError(
      'Only staff can change an order status.',
      'status_change_forbidden',
    );
  }

  assertTransition(current, requested);

  if (current === requested) {
    // A no-op save: keep the original timestamp rather than pretending the
    // order moved just now.
    delete data.statusChangedAt;
    return data;
  }

  data.status = requested;
  data.statusChangedAt = new Date().toISOString();
  return data;
}
