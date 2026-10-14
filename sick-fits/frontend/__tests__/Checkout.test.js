/* eslint-disable */
/**
 * Day 22 — the checkout form's failure paths, as the customer meets them.
 *
 * This file is the frontend half of the audit. The backend suite
 * (`npm run test:checkout` in sick-fits/backend) proves what each *Stripe*
 * failure becomes and what the resolver writes; this one proves the form
 * behaves on the other end of the same wire:
 *
 *   - a declined card shows words, frees the form and does not leave the
 *     loading bar running (it did: `nProgress.done()` was only reachable on the
 *     success path, and the Stripe error branch returned before it),
 *   - a double-click sends ONE charge request (it sent two: `loading` was never
 *     used, so the button stayed live),
 *   - our own API unreachable, or a response with no order in it, produces a
 *     sentence instead of a stuck spinner or a TypeError,
 *   - a message from our resolver is shown as written, and a message from
 *     anywhere else never is.
 *
 * The Stripe.js and Stripe Elements layers are mocked (there is no browser
 * payment sheet in jsdom) — everything above them, including the real
 * `useMutation` from Apollo, runs for real.
 */
import { MockedProvider } from '@apollo/client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import Router from 'next/router';
import nProgress from 'nprogress';
import { CardElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Checkout, CREATE_ORDER_MUTATION } from '../components/Checkout';
import { CURRENT_USER_QUERY } from '../components/User';
import { MESSAGES } from '../lib/checkoutMessages';

jest.mock('nprogress', () => ({
  __esModule: true,
  default: { start: jest.fn(), done: jest.fn() }
}));

jest.mock('@stripe/stripe-js', () => ({
  loadStripe: jest.fn(() => Promise.resolve({}))
}));

jest.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }) => children,
  CardElement: jest.fn(() => null),
  useStripe: jest.fn(),
  useElements: jest.fn()
}));

jest.mock('../lib/cartState', () => ({ useCart: jest.fn() }));

const { useCart } = require('../lib/cartState');

const closeCart = jest.fn();
const card = { clear: jest.fn() };
const stripe = { createPaymentMethod: jest.fn() };

const ORDER = {
  __typename: 'Order',
  id: 'ord1',
  charge: 'pi_1',
  total: 5000,
  items: []
};

const orderMock = (token, data = { checkout: ORDER }) => ({
  request: { query: CREATE_ORDER_MUTATION, variables: { token } },
  result: { data }
});

const orderErrorMock = (token, ...errors) => ({
  request: { query: CREATE_ORDER_MUTATION, variables: { token } },
  result: { errors }
});

const networkFailureMock = token => ({
  request: { query: CREATE_ORDER_MUTATION, variables: { token } },
  error: new Error('Failed to fetch')
});

const userMock = {
  request: { query: CURRENT_USER_QUERY },
  result: { data: { authenticatedItem: null } }
};

const renderCheckout = (mocks = []) =>
  render(
    <MockedProvider mocks={mocks}>
      <Checkout />
    </MockedProvider>
  );

const form = () => document.querySelector('form');
const errorBox = () => screen.queryByTestId('checkout-error');
const button = () => screen.getByRole('button');
const lastCardProps = () => CardElement.mock.calls[CardElement.mock.calls.length - 1][0];

const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  jest.clearAllMocks();
  useStripe.mockReturnValue(stripe);
  useElements.mockReturnValue({ getElement: () => card });
  useCart.mockReturnValue({ closeCart });
});

describe('<Checkout/> failure paths', () => {
  it('starts with no error and a live button', () => {
    renderCheckout();
    expect(errorBox()).toBeNull();
    expect(button()).not.toBeDisabled();
    expect(button()).toHaveTextContent('Check Out');
  });

  it('shows a declined card in words, frees the form and stays put', async () => {
    stripe.createPaymentMethod.mockResolvedValue({
      error: {
        type: 'card_error',
        code: 'card_declined',
        message: 'Your card was declined.'
      }
    });
    renderCheckout();

    await act(async () => {
      fireEvent.submit(form());
    });

    expect(errorBox()).toHaveTextContent(
      'Your card was declined by your bank. Try a different card.'
    );
    // The three things the old code got wrong on this path:
    expect(nProgress.done).toHaveBeenCalled(); // the bar stopped
    expect(button()).not.toBeDisabled(); // the form came back
    expect(card.clear).toHaveBeenCalled(); // the card can be retyped
    // And the two things it must not do:
    expect(Router.router.push).not.toHaveBeenCalled();
    expect(closeCart).not.toHaveBeenCalled();
  });

  it('sends one charge request when the form is submitted twice in one tick', async () => {
    const gate = deferred();
    stripe.createPaymentMethod.mockReturnValue(gate.promise);
    renderCheckout([orderMock('pm_test_1'), userMock]);

    await act(async () => {
      fireEvent.submit(form());
      fireEvent.submit(form());
    });

    // The button is not disabled yet at this point — React has not re-rendered —
    // so only the synchronous guard in the handler can stop the second request.
    expect(stripe.createPaymentMethod).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ paymentMethod: { id: 'pm_test_1' } });
      await gate;
    });

    await waitFor(() => expect(Router.router.push).toHaveBeenCalledTimes(1));
    expect(closeCart).toHaveBeenCalledTimes(1);
  });

  it('disables the button and the card fields while a charge is in flight', async () => {
    const gate = deferred();
    stripe.createPaymentMethod.mockReturnValue(gate.promise);
    renderCheckout([orderMock('pm_test_1'), userMock]);

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('Checking out');
    expect(lastCardProps().options.disabled).toBe(true);

    await act(async () => {
      gate.resolve({ paymentMethod: { id: 'pm_test_1' } });
      await gate;
    });

    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
  });

  it('routes to the order and closes the drawer when the payment goes through', async () => {
    stripe.createPaymentMethod.mockResolvedValue({ paymentMethod: { id: 'pm_test_1' } });
    renderCheckout([orderMock('pm_test_1'), userMock]);

    await act(async () => {
      fireEvent.submit(form());
    });

    await waitFor(() =>
      expect(Router.router.push).toHaveBeenCalledWith({
        pathname: '/order/[id]',
        query: { id: 'ord1' }
      })
    );
    expect(closeCart).toHaveBeenCalled();
    expect(nProgress.done).toHaveBeenCalled();
  });

  it('says the outcome is unknown when our own API cannot be reached', async () => {
    stripe.createPaymentMethod.mockResolvedValue({ paymentMethod: { id: 'pm_test_1' } });
    renderCheckout([networkFailureMock('pm_test_1')]);

    await act(async () => {
      fireEvent.submit(form());
    });

    await waitFor(() => expect(errorBox()).toHaveTextContent(MESSAGES.connection));
    expect(nProgress.done).toHaveBeenCalled();
    expect(button()).not.toBeDisabled();
    expect(Router.router.push).not.toHaveBeenCalled();
  });

  it('shows a message our own resolver wrote, word for word', async () => {
    stripe.createPaymentMethod.mockResolvedValue({ paymentMethod: { id: 'pm_test_1' } });
    renderCheckout([orderErrorMock('pm_test_1', new GraphQLError(MESSAGES.emptyCart))]);

    await act(async () => {
      fireEvent.submit(form());
    });

    await waitFor(() => expect(errorBox()).toHaveTextContent(MESSAGES.emptyCart));
    expect(Router.router.push).not.toHaveBeenCalled();
  });

  it('never shows a message that was written for a developer', async () => {
    stripe.createPaymentMethod.mockResolvedValue({ paymentMethod: { id: 'pm_test_1' } });
    renderCheckout([
      orderErrorMock('pm_test_1', new GraphQLError("Cannot read properties of null (reading 'id')"))
    ]);

    await act(async () => {
      fireEvent.submit(form());
    });

    await waitFor(() => expect(errorBox()).toHaveTextContent(MESSAGES.processorProblem));
    expect(errorBox().textContent).not.toMatch(/null|undefined|prisma|stripe/i);
  });

  it('copes with a response that contains no order, instead of a TypeError', async () => {
    stripe.createPaymentMethod.mockResolvedValue({ paymentMethod: { id: 'pm_test_1' } });
    renderCheckout([orderMock('pm_test_1', { checkout: null })]);

    await act(async () => {
      fireEvent.submit(form());
    });

    await waitFor(() => expect(errorBox()).toHaveTextContent(MESSAGES.connection));
    expect(Router.router.push).not.toHaveBeenCalled();
    expect(closeCart).not.toHaveBeenCalled();
  });

  it('clears a decline from the screen once the customer edits the card', async () => {
    stripe.createPaymentMethod.mockResolvedValue({
      error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' }
    });
    renderCheckout();

    await act(async () => {
      fireEvent.submit(form());
    });
    expect(errorBox()).not.toBeNull();

    await act(async () => {
      lastCardProps().onChange();
    });
    expect(errorBox()).toBeNull();
  });

  it('does not send a payment method when Stripe.js has not loaded yet', async () => {
    useStripe.mockReturnValue(null);
    renderCheckout();

    await act(async () => {
      fireEvent.submit(form());
    });

    expect(stripe.createPaymentMethod).not.toHaveBeenCalled();
    expect(nProgress.start).not.toHaveBeenCalled();
  });
});
