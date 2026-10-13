/* eslint-disable */
import { KeystoneContext } from '@keystone-next/types';
import { clampQuantity, lineLimit, mergeQuantity } from '../lib/cartRules';

/**
 * Fold a browser-held cart into the signed-in customer's server cart.
 *
 * Day 21's task: "Anonymous cart: a localStorage cart that merges into the server
 * cart on sign-in, with a merge rule you can explain out loud." This is the server
 * half of that rule; `frontend/lib/anonCart.js` is the browser half, and both call
 * `mergeQuantity` from `lib/cartRules.ts` so there is exactly one definition.
 *
 * THE RULE, OUT LOUD
 * Per product, the merged quantity is the LARGER of what the server already had and
 * what the browser was holding — never the sum. Summing double-counts an item the
 * customer added both on the phone and while signed in; the maximum never loses a
 * line and never invents stock. The result is still capped by the product's line
 * limit, exactly like any other write.
 *
 * What it deliberately does NOT do:
 *   - it never deletes a line the server already had (a merge must not lose data)
 *   - it never merges a product that is not purchasable right now: the read goes
 *     through `rules.canReadProducts`, so a Draft/Unavailable/deleted product is
 *     not found and its browser line is dropped rather than resurrected
 *   - it never touches another customer's rows: every read and write is scoped to
 *     the session's own item id
 *
 * Called with no items (or a malformed list) it is a no-op, so a customer whose
 * localStorage was cleared signs in normally.
 */
export default async function mergeCart(
  root: any,
  { items }: { items: { productId: string; quantity: number }[] },
  context: KeystoneContext,
): Promise<any> {
  const sesh = context.session as any;
  if (!sesh?.itemId) {
    throw new Error('You must be logged in to do this!');
  }

  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  // One line per product, even if the caller sent duplicates: the merge folds
  // them together by the same max rule before anything is written.
  const wanted = new Map<string, number>();
  for (const item of items) {
    if (!item || !item.productId) continue;
    const key = String(item.productId);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity < 1) continue;
    wanted.set(key, mergeQuantity(wanted.get(key) || 0, quantity));
  }

  if (wanted.size === 0) {
    return [];
  }

  // The customer's existing cart, read through the list API so `rules.canOrder`
  // scopes it (and the explicit user filter keeps an admin's merge to their own
  // rows). `findMany` may hand the product back as an id or as an object
  // depending on the version, so both shapes are accepted.
  // `readonly`, because keystone-next's generated type for `findMany` hands back a
  // readonly array and widening it here would add a 24th pre-existing tsc error.
  let existingItems: readonly any[] = [];
  try {
    existingItems = await context.lists.CartItem.findMany({
      where: { user: { id: sesh.itemId } },
    });
  } catch (error) {
    console.error('mergeCart: could not read the existing cart', error);
    throw new Error('Could not merge your bag. Please try again.');
  }

  const productIdOf = (row: any) => {
    const product = row?.product;
    if (!product) return null;
    return typeof product === 'object' ? product.id : product;
  };

  const results: any[] = [];

  for (const [productId, browserQuantity] of wanted) {
    // Read the product before writing: this is what makes the ceiling real, and
    // it is also why an unpurchasable product cannot be merged in.
    const product = await context.lists.Product.findOne({ where: { id: productId } });
    if (!product) {
      console.log(`mergeCart: dropping ${productId} — no longer purchasable`);
      continue;
    }

    const limit = lineLimit(product);
    const existing = existingItems.find((row) => String(productIdOf(row)) === String(productId));

    if (existing) {
      const merged = mergeQuantity(existing.quantity, browserQuantity, limit);
      if (merged === Number(existing.quantity)) {
        // The server already had at least as much. Touch nothing.
        results.push({ id: existing.id, quantity: existing.quantity });
        continue;
      }
      const updateResult = await context.graphql.run({
        query: `
          mutation UpdateCartItem($id: ID!, $quantity: Int!) {
            updateCartItem(id: $id, data: { quantity: $quantity }) {
              id
              quantity
            }
          }
        `,
        variables: { id: existing.id, quantity: merged },
      });
      results.push(updateResult.updateCartItem);
      continue;
    }

    const quantity = clampQuantity(browserQuantity, limit);
    const createResult = await context.graphql.run({
      query: `
        mutation CreateCartItem($productId: ID!, $userId: ID!, $quantity: Int!) {
          createCartItem(data: { product: { connect: { id: $productId } }, user: { connect: { id: $userId } }, quantity: $quantity }) {
            id
            quantity
          }
        }
      `,
      variables: { productId, userId: sesh.itemId, quantity },
    });
    results.push(createResult.createCartItem);
  }

  return results;
}
