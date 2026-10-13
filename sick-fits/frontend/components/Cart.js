import { useMutation } from '@apollo/client';
import gql from 'graphql-tag';
import Link from 'next/link';
import { useState } from 'react';
import { mergeForDisplay } from '../lib/anonCart';
import { cartSummary, clampQuantity, lineLimit, productIdOf } from '../lib/cartLines';
import { useCart } from '../lib/cartState';
import formatMoney from '../lib/formatMoney';
import { Checkout } from './Checkout';
import RemoveFromCart from './RemoveFromCart';
import { CURRENT_USER_QUERY, useUser } from './User';

// Day 20, "quantity changes": the cart can now change a line's quantity in place.
// The mutation is Keystone's generated updateCartItem; `rules.canOrder` on the
// CartItem list means a customer can only reach their own rows.
export const UPDATE_CART_ITEM_MUTATION = gql`
  mutation UPDATE_CART_ITEM_MUTATION($id: ID!, $quantity: Int!) {
    updateCartItem(id: $id, data: { quantity: $quantity }) {
      id
      quantity
      product {
        id
        name
        price
        stock
      }
    }
  }
`;

/**
 * The − / + control. Deliberately dumb: it is handed the number, the bounds and
 * two callbacks, so it can be tested on its own and reused by both the signed-in
 * cart and (day 21) the browser-held cart.
 *
 * `aria-label`s name the product, because a bag with three of the same figure is
 * unusable with a screen reader otherwise.
 */
export function QuantityStepper({
  quantity,
  limit,
  name = 'this item',
  busy = false,
  onDecrease,
  onIncrease
}) {
  const atFloor = quantity <= 1;
  const atLimit = quantity >= limit;

  return (
    <div className="flex items-center gap-2" data-testid="quantity-stepper">
      <button
        type="button"
        onClick={onDecrease}
        disabled={busy || atFloor}
        aria-label={`Decrease quantity of ${name}`}
        title={atFloor ? 'Use remove to take this out of your bag' : 'One fewer'}
        className="w-8 h-8 flex items-center justify-center rounded-full border border-neutral-300 text-neutral-600 hover:border-neutral-500 hover:text-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        &minus;
      </button>
      <span
        className="w-8 text-center tabular-nums font-medium text-neutral-800"
        data-testid="quantity-value"
        aria-live="polite"
      >
        {quantity}
      </span>
      <button
        type="button"
        onClick={onIncrease}
        disabled={busy || atLimit}
        aria-label={`Increase quantity of ${name}`}
        title={atLimit ? `Only ${limit} per order` : 'One more'}
        className="w-8 h-8 flex items-center justify-center rounded-full border border-neutral-300 text-neutral-600 hover:border-neutral-500 hover:text-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        +
      </button>
    </div>
  );
}

function CartItem({ cartItem, onChangeQuantity, onRemoveLocal, busyId, error }) {
  const { product } = cartItem;

  // A line whose product was deleted still exists on the server. It cannot be
  // priced, but it must stay visible — Hiding it would leave the customer with a
  // bag count they cannot clear.
  if (!product) {
    return (
      <li
        className="flex items-center justify-between py-4 border-b border-neutral-200"
        data-testid="cart-line-unavailable"
      >
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-neutral-500">No longer available</h3>
          <p className="mt-1 text-sm text-neutral-500">
            This item was removed from the shop and is not counted in your total. Remove it to
            clear the line.
          </p>
        </div>
        <div className="ml-4 flex-shrink-0">
          {cartItem.local ? (
            <RemoveFromCart
              id={cartItem.id}
              label="this unavailable item"
              onRemove={onRemoveLocal}
              local
            />
          ) : (
            <RemoveFromCart id={cartItem.id} label="this unavailable item" />
          )}
        </div>
      </li>
    );
  }

  const limit = lineLimit(product);
  const lineTotal = product.price * cartItem.quantity;
  const atLimit = cartItem.quantity >= limit;

  return (
    <li
      className="flex items-start justify-between py-4 border-b border-neutral-200"
      data-testid="cart-line"
    >
      <div className="flex items-start space-x-4 flex-1 min-w-0">
        <img
          src={product.photo?.image?.publicUrlTransformed}
          alt={product.name}
          className="w-20 h-20 md:w-24 md:h-24 object-cover rounded-lg shadow-sm flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-neutral-800 truncate">{product.name}</h3>
          <div className="mt-1 text-sm text-neutral-600">
            <span className="font-medium" data-testid="line-total">
              {formatMoney(lineTotal)}
            </span>
            <span className="mx-1">-</span>
            <span className="text-neutral-500">
              {cartItem.quantity} &times; {formatMoney(product.price)} each
            </span>
          </div>
          <div className="mt-3">
            <QuantityStepper
              quantity={cartItem.quantity}
              limit={limit}
              name={product.name}
              busy={busyId === cartItem.id}
              onDecrease={() => onChangeQuantity(cartItem, -1)}
              onIncrease={() => onChangeQuantity(cartItem, 1)}
            />
            {atLimit && (
              <p className="mt-1 text-xs text-amber-700" data-testid="line-limit-note">
                {limit === 1 ? 'Only one left' : `Only ${limit} per order`}
              </p>
            )}
            {error && busyId !== cartItem.id && (
              <p className="mt-1 text-xs text-red-600" data-testid="line-error">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="ml-4 flex-shrink-0">
        {cartItem.local ? (
          <RemoveFromCart id={cartItem.id} label={product.name} onRemove={onRemoveLocal} local />
        ) : (
          <RemoveFromCart id={cartItem.id} label={product.name} />
        )}
      </div>
    </li>
  );
}

export default function Cart() {
  const me = useUser();
  const {
    cartOpen,
    closeCart,
    localCart = [],
    changeLocalQuantity,
    removeLocalItem
  } = useCart();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [errorId, setErrorId] = useState(null);
  const [notice, setNotice] = useState(null);

  const [updateCartItem] = useMutation(UPDATE_CART_ITEM_MUTATION, {
    refetchQueries: [{ query: CURRENT_USER_QUERY, fetchPolicy: 'network-only' }],
    awaitRefetchQueries: true
  });

  const signedIn = !!me;

  // Day 21: a signed-out visitor sees the cart held in this browser. A signed-in
  // customer sees their server cart with any browser-held lines folded in by the
  // same larger-quantity rule the merge uses — so an unmerged line is visible
  // rather than looking like it vanished.
  const lines = mergeForDisplay(signedIn ? me.cart || [] : [], localCart);
  const { priced, unavailable, count, totalPrice, isEmpty } = cartSummary(lines);
  const pendingLocal = localCart.length;

  async function handleChangeQuantity(cartItem, delta) {
    const limit = lineLimit(cartItem.product);
    const wanted = clampQuantity(Number(cartItem.quantity) + delta, limit);

    setNotice(null);
    setErrorId(null);

    // The stepper is already disabled at both bounds; this is the guard for a
    // double-click that lands twice before the refetch returns.
    if (wanted === Number(cartItem.quantity)) {
      setNotice(
        delta > 0 ? `Only ${limit} per order.` : 'Use remove to take this out of your bag.'
      );
      return;
    }

    // Local lines change in the browser; there is no server row to write yet.
    if (!signedIn || cartItem.local) {
      changeLocalQuantity(productIdOf(cartItem), delta);
      return;
    }

    setBusyId(cartItem.id);
    setError(null);

    try {
      await updateCartItem({ variables: { id: cartItem.id, quantity: wanted } });
    } catch (err) {
      setError(err?.message || 'Could not change that quantity.');
      setErrorId(cartItem.id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className={`fixed inset-y-0 right-0 w-full md:w-150 bg-white shadow-2xl z-50 transform transition-transform duration-300 ease-custom ${
        cartOpen ? 'translate-x-0' : 'translate-x-full'
      }`}
      style={{ maxWidth: '28rem' }}
      data-testid="cart-drawer"
    >
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-neutral-900">
                {signedIn ? `${me.name}'s Cart` : 'Your Bag'}
              </h2>
              <p className="text-sm text-neutral-500 mt-1" data-testid="cart-summary">
                {isEmpty
                  ? 'Your cart is empty'
                  : `${count} item${count !== 1 ? 's' : ''} in ${priced.length} line${
                      priced.length !== 1 ? 's' : ''
                    }`}
              </p>
            </div>
            <button
              onClick={closeCart}
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-neutral-100 text-neutral-500 hover:text-neutral-700 transition-colors"
              aria-label="Close cart"
            >
              <span className="text-2xl">&times;</span>
            </button>
          </div>
        </div>

        {/* Notice / error strip — the cart always says why it refused something */}
        {(notice || error) && (
          <div className="px-6 pt-3">
            <p
              className={`text-xs ${error ? 'text-red-600' : 'text-amber-700'}`}
              data-testid="cart-notice"
              role="status"
            >
              {error || notice}
            </p>
          </div>
        )}

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto px-6 py-2">
          {isEmpty ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-6">
              <div className="w-24 h-24 mb-6 rounded-full bg-neutral-100 flex items-center justify-center">
                <svg
                  className="w-12 h-12 text-neutral-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-neutral-700 mb-2">Your cart is empty</h3>
              <p className="text-neutral-500 mb-6">Add some items to get started!</p>
              <button
                onClick={closeCart}
                className="px-6 py-3 bg-primary text-white font-medium rounded-lg hover:bg-primary-dark transition-colors"
              >
                Continue Shopping
              </button>
            </div>
          ) : (
            <ul className="space-y-2" data-testid="cart-lines">
              {lines.map(cartItem => (
                <CartItem
                  key={cartItem.id || productIdOf(cartItem)}
                  cartItem={cartItem}
                  onChangeQuantity={handleChangeQuantity}
                  onRemoveLocal={removeLocalItem}
                  busyId={busyId}
                  error={errorId === cartItem.id ? error : null}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        {!isEmpty && (
          <div className="border-t border-neutral-200 px-6 py-2">
            {signedIn && pendingLocal > 0 && (
              <p className="text-xs text-neutral-500 mb-2" data-testid="merge-pending-note">
                {pendingLocal} line{pendingLocal !== 1 ? 's' : ''} from this device{' '}
                {pendingLocal !== 1 ? 'are' : 'is'} being merged into your bag.
              </p>
            )}
            <div className="flex items-center justify-between mb-2">
              <span className="text-lg font-semibold text-neutral-700">Total</span>
              <span className="text-2xl font-bold text-primary" data-testid="cart-total">
                {formatMoney(totalPrice)}
              </span>
            </div>
            {unavailable.length > 0 && (
              <p className="text-xs text-neutral-500 mb-2">
                {unavailable.length} line{unavailable.length !== 1 ? 's are' : ' is'} no longer
                available and {unavailable.length !== 1 ? 'are' : 'is'} not counted in this total.
              </p>
            )}
            <div className="space-y-3">
              {signedIn ? (
                <Checkout />
              ) : (
                <>
                  <Link
                    href="/signin"
                    className="block w-full py-2 text-center bg-[#16140f] hover:bg-[#ff4a17] text-white font-medium rounded-lg transition-colors"
                    data-testid="signin-to-checkout"
                  >
                    Sign in to check out
                  </Link>
                  <p className="text-xs text-neutral-500 text-center">
                    Your bag is saved on this device and merges into your account when you sign in —
                    nothing added here is lost.
                  </p>
                </>
              )}
              <button
                onClick={closeCart}
                className="w-full py-1 border-2 border-neutral-300 text-neutral-700 font-medium rounded-lg hover:bg-neutral-50 transition-colors"
              >
                Continue Shopping
              </button>
            </div>
            <p className="text-xs text-neutral-400 text-center mt-1">
              Free shipping on orders over $50
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
