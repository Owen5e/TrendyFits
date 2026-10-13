import { useMutation } from '@apollo/client';
import gql from 'graphql-tag';
import { useState } from 'react';
import { CURRENT_USER_QUERY } from './User';

// Exported so the tests can name the exact document they are mocking.
export const REMOVE_FROM_CART_MUTATION = gql`
  mutation REMOVE_FROM_CART_MUTATION($id: ID!) {
    removeFromCart(id: $id) {
      id
    }
  }
`;

/**
 * Take the removed CartItem out of the cache.
 *
 * ADD IT 2026-10-12 (day 20): this used to be one line —
 * `cache.evict(cache.identify(payload.data.removeFromCart))` — and it was a live
 * bug, not a theoretical one. `cache.identify()` gets its object id from the
 * `__typename` the server sends; when a result arrives without one, identify
 * returns `undefined`, `cache.evict(undefined)` throws
 * `Cannot read properties of undefined (reading 'id')`, and because the throw
 * happens inside the mutation's update callback the whole removal FAILS — the
 * button appears to do nothing. Removing an item is the one control a customer
 * must never find broken, so the eviction is now best-effort: if the object
 * cannot be identified, the refetch below still refreshes the cart.
 */
function update(cache, payload) {
  const removed = payload?.data?.removeFromCart;
  const id = removed && cache.identify(removed);
  if (id) {
    cache.evict(id);
  }
}

/**
 * Day 20, "remove item": three things changed here.
 *
 * 1. A failed removal used to be silent — the button just did nothing, which
 *    reads as a broken page. The error is now shown next to the control.
 * 2. The user query is refetched, so removing the last line leaves a genuinely
 *    empty cart (the drawer shows its empty panel without a reload) instead of a
 *    bag whose count only corrects itself on the next poll. That refetch is also
 *    what makes the guarded eviction above safe.
 * 3. The control names what it removes, so a bag with three of the same figure
 *    is usable with a screen reader.
 */
export default function RemoveFromCart({ id, label = 'item' }) {
  const [errorMessage, setErrorMessage] = useState(null);
  const [removeFromCart, { loading }] = useMutation(REMOVE_FROM_CART_MUTATION, {
    variables: { id },
    update,
    refetchQueries: [{ query: CURRENT_USER_QUERY, fetchPolicy: 'network-only' }],
    awaitRefetchQueries: true
  });

  async function handleRemove() {
    setErrorMessage(null);
    try {
      await removeFromCart();
    } catch (err) {
      setErrorMessage(err?.message || 'Could not remove that item.');
    }
  }

  return (
    <>
      <button
        onClick={handleRemove}
        disabled={loading}
        type="button"
        title="Remove item from cart"
        aria-label={`Remove ${label} from cart`}
        data-testid="remove-from-cart"
        className="w-10 h-10 flex items-center justify-center text-2xl md:text-3xl text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        &times;
      </button>
      {errorMessage && (
        <p className="text-xs text-red-600 text-center" data-testid="remove-error" role="status">
          {errorMessage}
        </p>
      )}
    </>
  );
}
