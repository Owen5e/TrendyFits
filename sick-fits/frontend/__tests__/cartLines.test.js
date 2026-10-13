/**
 * Day 20 — cart edge cases, at the level they are decided.
 *
 * Every one of the day's five bullets is decided in `lib/cartLines.js`, so that
 * is where they are asserted first: quantity changes, remove item, max stock,
 * empty cart and price recalculation. `cartEdgeCases.test.js` then proves the
 * components actually call these rules.
 */
import {
  DEFAULT_LINE_LIMIT,
  MIN_LINE_QUANTITY,
  addLine,
  cartSummary,
  changeLineQuantity,
  clampQuantity,
  findLine,
  lineLimit,
  linePrice,
  removeLine
} from '../lib/cartLines';

const product = (overrides = {}) => ({
  id: 'p1',
  name: 'Yeti Hondo',
  price: 3423,
  ...overrides
});

const line = (overrides = {}) => ({
  id: 'cart-1',
  quantity: 2,
  product: product(),
  ...overrides
});

describe('max stock — the ceiling itself', () => {
  it('uses the product stock when the product records one', () => {
    expect(lineLimit(product({ stock: 3 }))).toBe(3);
    expect(lineLimit(product({ stock: 1 }))).toBe(1);
  });

  it('falls back to the default line limit when stock is missing, null or nonsense', () => {
    expect(lineLimit(product())).toBe(DEFAULT_LINE_LIMIT);
    expect(lineLimit(product({ stock: null }))).toBe(DEFAULT_LINE_LIMIT);
    expect(lineLimit(product({ stock: 0 }))).toBe(DEFAULT_LINE_LIMIT);
    expect(lineLimit(product({ stock: 'lots' }))).toBe(DEFAULT_LINE_LIMIT);
    expect(lineLimit(undefined)).toBe(DEFAULT_LINE_LIMIT);
  });

  it('rounds a fractional stock down so 2.9 units of stock is 2', () => {
    expect(lineLimit(product({ stock: 2.9 }))).toBe(2);
  });

  it('clamps any quantity into 1..limit', () => {
    expect(clampQuantity(0, 5)).toBe(MIN_LINE_QUANTITY);
    expect(clampQuantity(-4, 5)).toBe(MIN_LINE_QUANTITY);
    expect(clampQuantity(3, 5)).toBe(3);
    expect(clampQuantity(99, 5)).toBe(5);
    expect(clampQuantity('2', 5)).toBe(2);
    expect(clampQuantity(NaN, 5)).toBe(MIN_LINE_QUANTITY);
    // an unusable limit falls back to the default limit, not to 1
    expect(clampQuantity(4, 0)).toBe(4);
    expect(clampQuantity(99, 0)).toBe(DEFAULT_LINE_LIMIT);
  });
});

describe('quantity changes', () => {
  it('steps a line up and down without touching the others', () => {
    const cart = [line(), line({ id: 'cart-2', product: product({ id: 'p2' }), quantity: 1 })];

    const up = changeLineQuantity(cart, 'p1', 1);
    expect(findLine(up.cart, 'p1').quantity).toBe(3);
    expect(findLine(up.cart, 'p2').quantity).toBe(1);
    expect(up.capped).toBe(false);

    const down = changeLineQuantity(up.cart, 'p1', -1);
    expect(findLine(down.cart, 'p1').quantity).toBe(2);
  });

  it('never goes below 1 — going to zero is removal, not a decrement', () => {
    const result = changeLineQuantity([line({ quantity: 1 })], 'p1', -1);
    expect(findLine(result.cart, 'p1').quantity).toBe(1);
    expect(result.atFloor).toBe(true);
  });

  it('lands exactly on the stock without calling that capping', () => {
    const cart = [line({ quantity: 3, product: product({ stock: 4 }) })];
    const result = changeLineQuantity(cart, 'p1', 1);
    expect(findLine(result.cart, 'p1').quantity).toBe(4);
    expect(result.capped).toBe(false);
  });

  it('stops at the product stock and says it was capped', () => {
    const cart = [line({ quantity: 4, product: product({ stock: 4 }) })];
    const result = changeLineQuantity(cart, 'p1', 1);
    expect(findLine(result.cart, 'p1').quantity).toBe(4);
    expect(result.capped).toBe(true);
    expect(result.limit).toBe(4);
  });

  it('is a no-op for a product that is not in the cart', () => {
    const cart = [line()];
    const result = changeLineQuantity(cart, 'nope', 1);
    expect(result.cart).toHaveLength(1);
    expect(findLine(result.cart, 'nope')).toBeNull();
  });
});

describe('remove item', () => {
  it('drops exactly the line it was given', () => {
    const cart = [line(), line({ id: 'cart-2', product: product({ id: 'p2' }) })];
    const after = removeLine(cart, 'p1');
    expect(after).toHaveLength(1);
    expect(findLine(after, 'p2')).not.toBeNull();
  });

  it('leaves an empty cart when the last line goes', () => {
    expect(removeLine([line()], 'p1')).toEqual([]);
  });

  it('removing something that is not there changes nothing', () => {
    const cart = [line()];
    expect(removeLine(cart, 'ghost')).toHaveLength(1);
  });
});

describe('empty cart', () => {
  it('reports empty for undefined, null and [] alike', () => {
    [undefined, null, []].forEach(input => {
      const summary = cartSummary(input);
      expect(summary.isEmpty).toBe(true);
      expect(summary.count).toBe(0);
      expect(summary.totalPrice).toBe(0);
    });
  });

  it('is not empty just because every line is unpriced — those lines still need removing', () => {
    const summary = cartSummary([{ id: 'cart-9', quantity: 3, product: null }]);
    expect(summary.isEmpty).toBe(false);
    expect(summary.unavailable).toHaveLength(1);
    expect(summary.totalPrice).toBe(0);
    expect(summary.count).toBe(0);
  });
});

describe('price recalculation', () => {
  it('prices a line as price × quantity', () => {
    expect(linePrice(line({ quantity: 3 }))).toBe(3423 * 3);
    expect(linePrice({ id: 'x', quantity: 2, product: null })).toBe(0);
    expect(linePrice({ id: 'x', quantity: 'many', product: product() })).toBe(0);
  });

  it('recalculates the total from the current quantities, not from a cached one', () => {
    const cart = [line(), line({ id: 'cart-2', product: product({ id: 'p2', price: 500 }), quantity: 1 })];
    expect(cartSummary(cart).totalPrice).toBe(3423 * 2 + 500);

    const bumped = changeLineQuantity(cart, 'p1', 1).cart;
    expect(cartSummary(bumped).totalPrice).toBe(3423 * 3 + 500);
  });

  it('counts units, not lines', () => {
    const cart = [line({ quantity: 3 }), line({ id: 'cart-2', product: product({ id: 'p2' }), quantity: 2 })];
    const summary = cartSummary(cart);
    expect(summary.count).toBe(5);
    expect(summary.lineCount).toBe(2);
  });

  it('leaves a deleted product out of the total without hiding the line', () => {
    const cart = [line(), { id: 'cart-9', quantity: 4, product: null }];
    const summary = cartSummary(cart);
    expect(summary.totalPrice).toBe(3423 * 2);
    expect(summary.lines).toHaveLength(2);
    expect(summary.unavailable).toHaveLength(1);
  });
});

describe('adding a line (the ceiling in the other direction)', () => {
  it('creates a line when the product is not in the cart', () => {
    const result = addLine([], { id: 'p1', quantity: 1, product: product({ stock: 3 }) });
    expect(result.cart).toHaveLength(1);
    expect(result.cart[0].quantity).toBe(1);
    expect(result.capped).toBe(false);
  });

  it('merges into an existing line instead of duplicating it', () => {
    const result = addLine([line({ quantity: 1 })], { id: 'p1', quantity: 1, product: product({ stock: 3 }) });
    expect(result.cart).toHaveLength(1);
    expect(result.cart[0].quantity).toBe(2);
  });

  it('caps the merge at the limit and reports that it was capped', () => {
    const result = addLine([line({ quantity: 3 })], { id: 'p1', quantity: 1, product: product({ stock: 3 }) });
    expect(result.cart[0].quantity).toBe(3);
    expect(result.capped).toBe(true);
    expect(result.limit).toBe(3);
  });
});
