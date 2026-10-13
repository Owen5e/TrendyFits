/**
 * Cart line rules — the frontend half of `sick-fits/backend/lib/cartRules.ts`.
 *
 * WHY THIS FILE EXISTS
 * Every screen that shows a cart needs the same three answers: how many of this
 * product may a line hold, what does this line cost, and what happens to the
 * total when a line changes or goes away. Day 20's task ("cart edge cases:
 * quantity changes, remove item, max stock, empty cart, price recalculation")
 * put those answers in one pure module so they are testable without a browser,
 * and so `Cart.js`, `AddToCart.js` and `RemoveFromCart.js` cannot each grow their
 * own slightly different version of "the maximum".
 *
 * The numbers here mirror the backend's. `__tests__/cartRulesMirror.test.js`
 * reads the backend file and fails if the two copies drift apart, so this is a
 * pinned mirror rather than a hopeful duplicate.
 *
 * A "line" is the same shape in both places: `{ id, quantity, product }`, where
 * `product` carries `id`, `name`, `price` and (when the server records it)
 * `stock`. Local, browser-held lines use the product id as their `id`.
 */

/** The most of one product a customer may hold in a single line. */
export const DEFAULT_LINE_LIMIT = 10;

/** A line that exists holds at least one of the thing. Removal deletes the line. */
export const MIN_LINE_QUANTITY = 1;

/** How many of this product a line may hold: its stock, else the default limit. */
export function lineLimit(product) {
  const stock = Number(product?.stock);
  if (Number.isFinite(stock) && stock >= MIN_LINE_QUANTITY) {
    return Math.max(MIN_LINE_QUANTITY, Math.floor(stock));
  }
  return DEFAULT_LINE_LIMIT;
}

/** Fold any input into a legal line quantity: a whole number between 1 and the limit. */
export function clampQuantity(quantity, limit = DEFAULT_LINE_LIMIT) {
  const ceiling =
    Number.isFinite(limit) && limit >= MIN_LINE_QUANTITY ? Math.floor(limit) : DEFAULT_LINE_LIMIT;
  const wanted = Math.floor(Number(quantity));
  if (!Number.isFinite(wanted)) return MIN_LINE_QUANTITY;
  return Math.min(Math.max(wanted, MIN_LINE_QUANTITY), ceiling);
}

export function productIdOf(line) {
  return line?.product?.id ?? line?.productId ?? null;
}

/** What this line costs: price × quantity, and 0 when the product is gone. */
export function linePrice(line) {
  const price = Number(line?.product?.price);
  const quantity = Number(line?.quantity);
  if (!Number.isFinite(price) || !Number.isFinite(quantity)) return 0;
  return price * quantity;
}

export function findLine(cart, productId) {
  return (cart || []).find((line) => productIdOf(line) === productId) || null;
}

/**
 * Everything a cart screen needs, in one pass:
 *  - `lines`            every line, including ones whose product was deleted (they
 *                       must stay visible, or the customer cannot remove them)
 *  - `priced`           the lines that contribute to the total
 *  - `unavailable`      lines whose product is gone — priced at 0, kept for removal
 *  - `count`            total units in the bag (what the badge shows)
 *  - `totalPrice`       sum of linePrice over the priced lines
 *  - `isEmpty`          no lines at all — the "your cart is empty" state
 */
export function cartSummary(cart) {
  const lines = (cart || []).filter(Boolean);
  const priced = lines.filter((line) => line?.product);
  const unavailable = lines.filter((line) => !line?.product);
  const count = priced.reduce((tally, line) => tally + (Number(line.quantity) || 0), 0);
  const totalPrice = priced.reduce((tally, line) => tally + linePrice(line), 0);
  return {
    lines,
    priced,
    unavailable,
    lineCount: priced.length,
    count,
    totalPrice,
    isEmpty: lines.length === 0,
  };
}

/**
 * Add `incoming` of a product to a cart, merging into an existing line.
 * Returns a new cart plus whether the ceiling stopped it short — the caller
 * decides how to say so, but never silently drops the extra units.
 */
export function addLine(cart, incoming) {
  const lines = (cart || []).filter(Boolean);
  const productId = productIdOf(incoming);
  const existing = findLine(lines, productId);
  const limit = lineLimit(incoming.product);

  if (!existing) {
    const quantity = clampQuantity(incoming.quantity, limit);
    return {
      cart: [...lines, { ...incoming, quantity }],
      capped: quantity < Number(incoming.quantity),
      limit,
    };
  }

  const wanted = Number(existing.quantity) + Number(incoming.quantity);
  const quantity = clampQuantity(wanted, limit);
  return {
    cart: lines.map((line) => (line === existing ? { ...line, quantity } : line)),
    capped: quantity < wanted,
    limit,
  };
}

/**
 * Nudge one line by `delta`. The floor is 1 — going to zero is removal, and only
 * `removeLine` or the remove button does that — and the ceiling is the product's
 * line limit. Returns the cart and whether either bound was hit, so the UI can
 * explain itself instead of looking broken.
 */
export function changeLineQuantity(cart, productId, delta) {
  const lines = (cart || []).filter(Boolean);
  const line = findLine(lines, productId);
  if (!line) return { cart: lines, capped: false, atFloor: false };

  const limit = lineLimit(line.product);
  const wanted = Number(line.quantity) + Number(delta);
  const quantity = clampQuantity(wanted, limit);

  return {
    cart: lines.map((item) => (item === line ? { ...item, quantity } : item)),
    capped: quantity < wanted,
    atFloor: quantity <= MIN_LINE_QUANTITY,
    limit,
  };
}

/** Take a line out of the cart entirely. */
export function removeLine(cart, productId) {
  return (cart || []).filter((line) => line && productIdOf(line) !== productId);
}
