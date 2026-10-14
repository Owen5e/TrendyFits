/**
 * Day 22 — the checkout form, after the audit.
 *
 * WHAT WAS WRONG (see docs/CHECKOUT-AUDIT.md for the evidence)
 *
 *  1. Nothing stopped a second submit. `loading` existed but was never used, so
 *     the button stayed live while a charge was in flight and each click sent
 *     another request. The server now refuses to charge the same bag twice, and
 *     this file stops the second request from being sent at all.
 *  2. Every failure left the page mid-transition: `nProgress.start()` was called
 *     at the top and `nProgress.done()` only after a successful order, and the
 *     Stripe error path `return`ed before either `setLoading(false)` or
 *     `nProgress.done()`. A declined card therefore left the loading bar running
 *     for ever behind a form that looked busy.
 *  3. Only the Stripe card error was handled. If the call to our own API failed
 *     — network gone, server 500 — the promise rejected with nothing to catch it,
 *     so the customer got the same stuck spinner plus an unhandled rejection.
 *  4. `order.data.checkout.id` assumed the order came back. When it did not, the
 *     customer saw "Cannot read properties of null (reading 'id')".
 *  5. A stale error survived a corrected card, and the card fields stayed
 *     editable mid-charge.
 */
import { useMutation } from '@apollo/client';
import { CardElement, Elements, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import gql from 'graphql-tag';
import { useRouter } from 'next/dist/client/router';
import nProgress from 'nprogress';
import { useRef, useState } from 'react';
import styled from 'styled-components';
import { useCart } from '../lib/cartState';
import {
  describeCheckoutFailure,
  missingOrderFailure
} from '../lib/checkoutMessages';
import SickButton from './styles/SickButton';
import { CURRENT_USER_QUERY } from './User';
// Load Stripe once at module level
const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_KEY);
const CheckoutFormStyles = styled.form`
  box-shadow: 0 1px 2px 2px rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.06);
  padding: 1rem;
  display: grid;
  grid-gap: 1rem;

  /* Mobile responsiveness */
  @media (max-width: 300px) {
    padding: 0.75rem;
    grid-gap: 0.75rem;
  }

  /* Small mobile devices */
  @media (max-width: 300px) {
    padding: 0.5rem;
    grid-gap: 0.5rem;
  }
`;

const CheckoutError = styled.p`
  font-size: 0.8rem;
  line-height: 1.35;
  margin: 0;
  color: #a3231f;
`;

const CREATE_ORDER_MUTATION = gql`
  mutation CREATE_ORDER_MUTATION($token: String!) {
    checkout(token: $token) {
      id
      charge
      total
      items {
        id
        name
      }
    }
  }
`;

function CheckoutForm() {
  const [failure, setFailure] = useState(null);
  const [loading, setLoading] = useState(false);
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const { closeCart } = useCart();
  // State is not readable within the same tick it is set, so the double-click
  // guard cannot be `loading` alone: two clicks 40ms apart would both see false.
  // A ref is written synchronously, before the first await.
  const submitting = useRef(false);
  const [checkout] = useMutation(CREATE_ORDER_MUTATION, {
    refetchQueries: [{ query: CURRENT_USER_QUERY }]
  });

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting.current) return;
    if (!stripe || !elements) return;
    submitting.current = true;
    setFailure(null);
    setLoading(true);
    nProgress.start();

    try {
      const card = elements.getElement(CardElement);
      const { error: stripeError, paymentMethod } = await stripe.createPaymentMethod({
        type: 'card',
        card
      });

      if (stripeError) {
        setFailure(describeCheckoutFailure(stripeError));
        if (card) card.clear();
        return;
      }

      if (!paymentMethod || !paymentMethod.id) {
        setFailure(describeCheckoutFailure(null));
        return;
      }

      const order = await checkout({ variables: { token: paymentMethod.id } });

      const created = order && order.data && order.data.checkout;
      if (!created || !created.id) {
        // The charge may or may not have landed. Never route to a blank page.
        setFailure(missingOrderFailure());
        return;
      }

      router.push({
        pathname: `/order/[id]`,
        query: { id: created.id }
      });
      closeCart();
    } catch (err) {
      // A rejected mutation (our API unreachable, or a failure we wrote) lands
      // here. Before this try/catch it landed nowhere, behind a running spinner.
      setFailure(describeCheckoutFailure(err));
      const card = elements.getElement(CardElement);
      if (card) card.clear();
    } finally {
      setLoading(false);
      submitting.current = false;
      nProgress.done();
    }
  }

  return (
    <CheckoutFormStyles onSubmit={handleSubmit}>
      {failure && (
        <CheckoutError role="alert" data-testid="checkout-error">
          {failure.message}
        </CheckoutError>
      )}
      <CardElement
        options={{ disabled: loading }}
        onChange={() => {
          // A corrected card should not keep an old decline on screen.
          if (failure && failure.retryable) setFailure(null);
        }}
      />
      <SickButton disabled={loading} aria-busy={loading}>
        {loading ? 'Checking out…' : 'Check Out'}
      </SickButton>
    </CheckoutFormStyles>
  );
}

export function Checkout() {
  return (
    <Elements stripe={stripePromise}>
      <CheckoutForm />
    </Elements>
  );
}

export { CREATE_ORDER_MUTATION };
