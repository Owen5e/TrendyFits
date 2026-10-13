import { useMutation } from '@apollo/client';
import gql from 'graphql-tag';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeLines } from '../lib/anonCart';
import { useCart } from '../lib/cartState';
import { CURRENT_USER_QUERY, useUser } from './User';

// Exported so the tests can name the exact document they are mocking.
export const MERGE_CART_MUTATION = gql`
  mutation MERGE_CART_MUTATION($items: [CartLineInput!]!) {
    mergeCart(items: $items) {
      id
      quantity
    }
  }
`;

/**
 * Moves the browser-held cart into the signed-in customer's account. Renders
 * nothing on the happy path; it is mounted once in `pages/_app.js`, inside the
 * Apollo and cart providers, so a sign-in from any page is covered.
 *
 * The rule it applies is `mergeLines` (lib/anonCart.js) → `mergeQuantity`
 * (lib/cartLines.js) → `mergeQuantity` (backend/lib/cartRules.ts): per product the
 * larger quantity wins, never the sum. So an item added once signed out and once
 * signed in ends up as ONE unit, not two.
 *
 * Two things it is careful about:
 *
 *  - It only clears localStorage AFTER the server has confirmed the merge. A failed
 *    merge keeps the browser copy — that cart is the only copy of those items while
 *    the customer is offline — and shows a retry banner instead of quietly dropping
 *    them.
 *  - It runs once per sign-in (`attemptedFor`), because `useUser` polls every 5s and
 *    a merge that re-ran on every poll would be a write loop.
 */
export default function MergeAnonymousCart() {
  const me = useUser();
  const { localCart = [], emptyLocalCart } = useCart();
  const [status, setStatus] = useState('idle'); // idle | merging | failed
  const attemptedFor = useRef(null);

  const [mergeCart] = useMutation(MERGE_CART_MUTATION, {
    refetchQueries: [{ query: CURRENT_USER_QUERY, fetchPolicy: 'network-only' }],
    awaitRefetchQueries: true
  });

  const run = useCallback(async () => {
    setStatus('merging');
    try {
      const { items } = mergeLines(me?.cart || [], localCart);
      if (items.length > 0) {
        await mergeCart({ variables: { items } });
      }
      // Nothing to write means the server already holds at least as much of every
      // line, so clearing the browser copy loses nothing.
      emptyLocalCart();
      setStatus('idle');
    } catch (error) {
      setStatus('failed');
    }
  }, [me?.cart, localCart, mergeCart, emptyLocalCart]);

  useEffect(() => {
    if (!me?.id) {
      attemptedFor.current = null;
      setStatus('idle');
      return;
    }
    if (localCart.length === 0) return;
    if (attemptedFor.current === me.id) return;
    attemptedFor.current = me.id;
    run();
    // Deliberately keyed on the user id and the number of local lines: `run` is
    // rebuilt whenever the cart data changes, and depending on it would re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, localCart.length]);

  if (status !== 'failed') {
    return null;
  }

  return (
    <div
      className="fixed bottom-4 left-4 right-4 md:left-auto md:w-96 z-50 bg-white border border-neutral-200 shadow-elevated rounded-lg p-4"
      data-testid="merge-failed"
      role="status"
    >
      <p className="text-sm text-neutral-700">
        We could not move everything from this device into your bag just now. Your items are still
        saved here — nothing was lost.
      </p>
      <button
        type="button"
        onClick={run}
        className="mt-2 text-sm font-medium text-[#ff4a17] underline"
        data-testid="merge-retry"
      >
        {status === 'merging' ? 'Merging…' : 'Try again'}
      </button>
    </div>
  );
}
