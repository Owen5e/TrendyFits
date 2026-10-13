import { useMutation } from '@apollo/client';
import gql from 'graphql-tag';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { lineLimit } from '../lib/cartLines';
import { useCart } from '../lib/cartState';
import { CURRENT_USER_QUERY, useUser } from './User';

// Exported so the tests can name the exact document they are mocking.
export const ADD_TO_CART_MUTATION = gql`
  mutation ADD_TO_CART_MUTATION($id: ID!) {
    addToCart(productId: $id) {
      id
      quantity
      product {
        id
        name
        price
        stock
        description
        photo {
          image {
            publicUrlTransformed
          }
        }
      }
    }
  }
`;

export default function AddToCart({ id }) {
  const router = useRouter();
  const user = useUser();
  const { openCart } = useCart();
  const [message, setMessage] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  // Day 20, "max stock": the bag is the only place the product's own ceiling can
  // be read from, so the button disables itself at the limit instead of letting
  // the customer click into a refusal. The first add is always allowed — with no
  // line yet there is no product to read a stock figure from — and the server
  // refuses anything past the limit regardless of what this screen says.
  const existingLine = user?.cart?.find(line => line.product?.id === id) || null;
  const limit = lineLimit(existingLine?.product);
  const atLimit = !!existingLine && existingLine.quantity >= limit;

  const [addToCart, { loading, error }] = useMutation(ADD_TO_CART_MUTATION, {
    variables: { id },
    refetchQueries: [
      {
        query: CURRENT_USER_QUERY,
        fetchPolicy: 'network-only'
      }
    ],
    awaitRefetchQueries: true
  });

  const handleClick = async () => {
    setMessage(null);
    setErrorMessage(null);

    if (!id) {
      console.error('Cannot add to cart: product id is undefined');
      setErrorMessage('That product is not available.');
      return;
    }

    // Check if user is logged in
    if (!user) {
      router.push({
        pathname: '/signin',
        query: { from: router.asPath }
      });
      return;
    }

    if (atLimit) {
      setMessage(
        `Only ${limit} of ${existingLine.product.name} per order — your bag already has ${existingLine.quantity}.`
      );
      openCart();
      return;
    }

    try {
      await addToCart();
      setMessage('Added to bag');
      openCart();
    } catch (err) {
      // The server is the cap, so its refusal has to reach the customer.
      setErrorMessage(err?.message || 'Could not add that to your bag.');
    }
  };

  const shown =
    errorMessage ||
    message ||
    (atLimit
      ? `Only ${limit} per order — your bag already has ${existingLine.quantity}.`
      : null) ||
    (error ? error.message : null);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading || atLimit}
        aria-disabled={loading || atLimit}
        className="flex w-full justify-center items-center bg-[#16140f] hover:bg-[#ff4a17] disabled:bg-neutral-400 text-white px-4 py-2 rounded-md text-center text-[12px] font-mono font-lg transition-colors disabled:cursor-not-allowed"
      >
        {atLimit ? `MAX ${limit} IN BAG` : `+ ADD${loading ? 'ING' : ''} TO BAG`}
      </button>
      {shown && (
        <p
          className={`mt-1 text-[11px] text-center ${
            errorMessage || error ? 'text-red-600' : 'text-neutral-600'
          }`}
          data-testid="add-to-cart-message"
          role="status"
        >
          {shown}
        </p>
      )}
    </div>
  );
}
