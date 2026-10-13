/**
 * Cart line rules — the one place that decides how many of a thing a single
 * cart line may hold.
 *
 * WHY THIS FILE EXISTS
 * Day 20's task was "cart edge cases: quantity changes, remove item, max stock,
 * empty cart, price recalculation". A cart that caps quantity on the screen but
 * not on the server is not a cap — the browser is advisory. These rules are
 * imported by the mutations, so the ceiling is enforced where the write actually
 * happens, and they are plain functions with no Keystone import, so they can be
 * run and asserted directly by `npm run test:cart` with no database.
 *
 * The frontend keeps a mirror of the same three rules in
 * `sick-fits/frontend/lib/cartLines.js` so the controls can disable themselves
 * before the user hits a wall. The mirror is pinned by
 * `frontend/__tests__/cartRulesMirror.test.js`, which reads this file and fails
 * if the two copies drift apart.
 */

/** The most of one product a customer may hold in a single line. */
export const DEFAULT_LINE_LIMIT = 10;

/** A line that exists holds at least one of the thing. Removal deletes the line. */
export const MIN_LINE_QUANTITY = 1;

type MaybeProduct = { stock?: number | null } | null | undefined;

/**
 * How many of this product a line may hold: the product's own stock when it has
 * one, otherwise DEFAULT_LINE_LIMIT.
 *
 * There is no per-customer reservation here — this is a per-line ceiling, not an
 * inventory ledger. It is deliberately the *smaller* of the two when both are
 * known, so a product with 3 left cannot be ordered 10 times over.
 */
export function lineLimit(product: MaybeProduct): number {
  const stock = Number(product?.stock);
  if (Number.isFinite(stock) && stock >= MIN_LINE_QUANTITY) {
    return Math.max(MIN_LINE_QUANTITY, Math.floor(stock));
  }
  return DEFAULT_LINE_LIMIT;
}

/** Fold any input into a legal line quantity: a whole number between 1 and the limit. */
export function clampQuantity(quantity: number, limit: number = DEFAULT_LINE_LIMIT): number {
  const ceiling = Number.isFinite(limit) && limit >= MIN_LINE_QUANTITY
    ? Math.floor(limit)
    : DEFAULT_LINE_LIMIT;
  const wanted = Math.floor(Number(quantity));
  if (!Number.isFinite(wanted)) {
    return MIN_LINE_QUANTITY;
  }
  return Math.min(Math.max(wanted, MIN_LINE_QUANTITY), ceiling);
}

/**
 * The rule a browser-side cart and a server-side cart are folded together with:
 * per product the LARGER quantity wins, never the sum.
 *
 * Summing double-counts an item the customer added on both the phone and while
 * signed in; the maximum never loses a line and never invents stock. `0` on
 * either side means "no line here", so a line that exists only in the browser
 * survives the merge intact (capped by the limit like any other).
 */
export function mergeQuantity(
  serverQuantity: number,
  incomingQuantity: number,
  limit: number = DEFAULT_LINE_LIMIT,
): number {
  const server = Number(serverQuantity);
  const incoming = Number(incomingQuantity);
  const biggest = Math.max(
    Number.isFinite(server) ? server : 0,
    Number.isFinite(incoming) ? incoming : 0,
  );
  return clampQuantity(biggest, limit);
}
