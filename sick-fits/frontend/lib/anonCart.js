/**
 * The anonymous cart — what a signed-out visitor is carrying, kept in the
 * browser, and the one function that folds it into a server cart.
 *
 * Day 21's task: "Anonymous cart: a localStorage cart that merges into the server
 * cart on sign-in, with a merge rule you can explain out loud."
 *
 * THE RULE, OUT LOUD (the same words as `backend/lib/cartRules.ts#mergeQuantity`)
 * Per product, the merged quantity is the LARGER of what the server already had and
 * what this browser was holding — never the sum. Summing double-counts an item the
 * customer added both on the phone and while signed in; the maximum never loses a
 * line and never invents stock. The result is still capped by the product's line
 * limit. So: add 1 signed out, 1 signed in, sign in → 1, not 2. Add 3 signed out,
 * 1 signed in, sign in → 3.
 *
 * Storage is deliberately dumb: a JSON array of lines in one key, sanitised on the
 * way in and out, because localStorage is user-writable and half of this file's job
 * is refusing to trust it.
 */

import {
  addLine,
  cartSummary,
  changeLineQuantity,
  lineLimit,
  mergeQuantity,
  productIdOf,
  removeLine
} from './cartLines';

export const LOCAL_CART_KEY = 'trendyfits.cart.v1';

/** A corrupt or hostile payload cannot turn into an unbounded render. */
export const LOCAL_CART_MAX_LINES = 50;

/** localStorage throws in private mode and does not exist during SSR. */
function safeStorage(storage) {
  if (storage) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch (error) {
    // Safari in private mode throws on access, not on write.
  }
  return null;
}

/**
 * Coerce whatever was in storage into lines this app can render. Anything without
 * a usable product id or quantity is dropped rather than repaired — a made-up price
 * is worse than a missing line.
 */
export function sanitiseLines(value) {
  const raw = Array.isArray(value) ? value : [];
  const clean = [];

  raw.slice(0, LOCAL_CART_MAX_LINES).forEach(entry => {
    if (!entry || typeof entry !== 'object') return;

    const productId = entry.product?.id || entry.productId || entry.id;
    const quantity = Number(entry.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity < 1) return;

    const product = entry.product && entry.product.id ? { ...entry.product, id: productId } : null;

    clean.push({
      id: String(productId),
      quantity: Math.floor(quantity),
      product
    });
  });

  // One entry per product, LARGEST quantity wins — the same rule the server merge
  // uses. Summing here would let a corrupt payload inflate a line before the merge
  // rule ever sees it; `addLine` (which adds) is for a customer clicking twice.
  const byProduct = new Map();
  clean.forEach(line => {
    const key = String(line.product?.id || line.id);
    const current = byProduct.get(key);
    if (!current) {
      byProduct.set(key, line);
      return;
    }
    byProduct.set(key, {
      ...current,
      quantity: mergeQuantity(current.quantity, line.quantity, lineLimit(line.product || current.product))
    });
  });
  return [...byProduct.values()];
}

export function readLocalCart(storage) {
  const store = safeStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(LOCAL_CART_KEY);
    if (!raw) return [];
    return sanitiseLines(JSON.parse(raw));
  } catch (error) {
    return [];
  }
}

export function writeLocalCart(lines, storage) {
  const store = safeStorage(storage);
  if (!store) return false;
  try {
    store.setItem(LOCAL_CART_KEY, JSON.stringify(sanitiseLines(lines)));
    return true;
  } catch (error) {
    // Quota exceeded or storage disabled: the in-memory cart still works for this
    // page view, and every merge path treats an unreadable store as "nothing here".
    return false;
  }
}

export function clearLocalCart(storage) {
  const store = safeStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(LOCAL_CART_KEY);
    return true;
  } catch (error) {
    return false;
  }
}

export function addLocalLine(lines, incoming) {
  return addLine(lines, incoming).cart;
}

export function changeLocalLineQuantity(lines, productId, delta) {
  return changeLineQuantity(lines, productId, delta).cart;
}

export function removeLocalLine(lines, productId) {
  return removeLine(lines, productId);
}

export function localCartSummary(lines) {
  return cartSummary(lines);
}

/**
 * What to send to `mergeCart` when the customer signs in.
 *
 * Only the lines the server does not already cover are sent: a product the server
 * already holds at least as much of needs no write at all. `skipped` explains the
 * lines that could not be sent, so a caller can say so rather than silently drop
 * them.
 */
export function mergeLines(serverLines, localLines) {
  const items = [];
  const skipped = [];

  (localLines || []).forEach(line => {
    const productId = productIdOf(line);
    if (!productId) {
      skipped.push({ line, reason: 'no product id' });
      return;
    }

    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity < 1) {
      skipped.push({ line, reason: 'no quantity' });
      return;
    }

    const serverLine = (serverLines || []).find(item => productIdOf(item) === productId) || null;
    const serverQuantity = Number(serverLine?.quantity) || 0;
    const target = mergeQuantity(serverQuantity, quantity, lineLimit(line.product));

    if (target > serverQuantity) {
      items.push({ productId, quantity: target });
    }
  });

  return { items, skipped };
}

/**
 * The drawer's view while a merge is pending (or after one failed): per product the
 * larger quantity, with the lines that exist only in this browser kept visible. A
 * merge that has not happened yet must never look like items that vanished.
 */
export function mergeForDisplay(serverLines, localLines) {
  const lines = [...(serverLines || [])];

  (localLines || []).forEach(line => {
    const productId = productIdOf(line);
    const existing = lines.find(item => productIdOf(item) === productId);

    if (!existing) {
      lines.push({ ...line, local: true });
      return;
    }

    if (Number(line.quantity) > Number(existing.quantity)) {
      existing.quantity = Number(line.quantity);
    }
  });

  return lines;
}
