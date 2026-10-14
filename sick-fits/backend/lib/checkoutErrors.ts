/**
 * Day 22 — the words a customer reads when a payment does not go through.
 *
 * WHY THIS FILE EXISTS
 * Stripe's own messages are written for developers, not for shoppers. Probed on
 * 2026-10-14 against the live test-mode API, the raw strings are:
 *
 *   declined card        "Your card was declined."                       (fine)
 *   empty bag (amount 0) a 200-word paragraph about Setup Intents and
 *                        minimum charge amounts                        (not fine)
 *   lost connection      "An error occurred with our connection to Stripe."
 *                                                                       (not fine)
 *   wrong secret key     "Invalid API Key provided: sk_test_****0004"    (never)
 *   double submit        "There is currently another in-progress request
 *                        using this Idempotent Key (that probably means you
 *                        submitted twice, ...)"                        (not fine)
 *
 * So every failure that can reach a customer is translated here, once, into a
 * sentence that says three things: what happened, whether money may have moved,
 * and whether trying again is worth their time.
 *
 * TWO RULES
 *  1. A raw Stripe string is only ever shown when it is a whitelisted CARD
 *     message. Those are written for cardholders. Everything else is an
 *     internal detail, and the fallback sentence is ours.
 *  2. Nothing we invent may promise something we cannot know. Where the fate of
 *     a charge is genuinely unknown (a connection dropped mid-flight), the
 *     message says so and sends the customer to their orders page instead of
 *     claiming "you have not been charged".
 *
 * The browser mirror of this catalogue lives in
 * `frontend/lib/checkoutMessages.js`; `frontend/__tests__/checkoutMessagesMirror.test.js`
 * fails if the two drift apart.
 */

export interface CheckoutFailure {
  /** The sentence shown to the customer. */
  message: string;
  /** Is asking the customer to try again worth their time? */
  retryable: boolean;
  /** Stable label for logs and tests — never shown to a customer. */
  code: string;
}

/** Thrown so callers (and the GraphQL layer) carry the failure, not just a string. */
export class CheckoutFailureError extends Error {
  failure: CheckoutFailure;

  constructor(failure: CheckoutFailure) {
    super(failure.message);
    this.name = 'CheckoutFailureError';
    this.failure = failure;
  }
}

export function checkoutFailure(failure: CheckoutFailure): CheckoutFailureError {
  return new CheckoutFailureError(failure);
}

/**
 * Problems we detect ourselves, before (or instead of) asking Stripe anything.
 */
export const MESSAGES = {
  notSignedIn:
    'Please sign in before checking out — your bag is saved and waiting.',

  emptyCart:
    'Your bag is empty, so there is nothing to pay for yet.',

  belowMinimum:
    'Your bag total is below the smallest amount the card processor will accept. Add another item and try again.',

  alreadyProcessing:
    "We are already processing a payment for this bag. Do not click again — if your order does not turn up in a moment, check your orders page.",

  authenticationRequired:
    'Your bank asked for an extra verification step that this checkout cannot complete yet. You have not been charged — please try a different card.',

  processing:
    'Your payment is still being processed. Do not click again — check your orders page in a moment.',

  cancelled:
    'That payment attempt was cancelled before it completed. You have not been charged.',

  connection:
    'We lost the connection to the card processor before it confirmed the payment, so we cannot say yet whether it went through. Do not pay twice — check your orders page first, then try again.',

  unavailable:
    'Card payments are temporarily unavailable. You have not been charged. Please try again later.',

  rateLimited:
    'Too many payment attempts in a row. Wait a minute and try again — you have not been charged.',

  processorProblem:
    'The card processor could not complete this order. You have not been charged. Please try again.',

  cardFallback:
    'Your card could not be charged. Please try a different card.',

  chargedWithoutOrder:
    'Your payment went through, but we could not write the order down. You have been charged once — please contact us with reference',
};

/**
 * Card declines, in the cardholder's words rather than the acquirer's.
 * Keyed by Stripe's `code` (falling back to `decline_code`), whitelisted on
 * purpose: anything not listed here gets `MESSAGES.cardFallback`, never the raw
 * string, so a new Stripe code cannot leak a developer message into the UI.
 */
export const CARD_MESSAGES: { [code: string]: string } = {
  card_declined: 'Your card was declined by your bank. Try a different card.',
  expired_card: 'Your card has expired. Try a different card.',
  incorrect_cvc:
    'That security code does not match the card. Check the digits and try again.',
  incorrect_number:
    'That card number does not look right. Check it and try again.',
  insufficient_funds:
    'Your card does not have enough available funds for this order. Try a different card.',
  card_not_supported:
    'Your bank does not allow this card to be used for this payment. Try a different card.',
  currency_not_supported:
    'This card cannot be charged in US dollars. Try a different card.',
  authentication_failure:
    'Your bank could not verify this payment. Try a different card.',
  processing_error:
    'Your bank could not process the payment just now. Try again in a moment.',
  fraudulent:
    'Your bank blocked this payment. You have not been charged — contact your bank or use a different card.',
};

/**
 * Markers of a message that was written for a developer. Used by the tests to
 * assert no failure we produce ever contains one, and by the browser when it
 * decides whether a message that arrived from the server is one of ours.
 */
export const INTERNAL_MARKERS =
  /sk_(test|live)|pk_(test|live)|pi_[A-Za-z0-9]|pm_[A-Za-z0-9]|https?:\/\/|idempoten|Setup Intent|SetupIntent|amount_too_small|parameter_invalid|No such |Invalid API Key|Stripe|stripe/i;

export function isInternalMessage(message: string): boolean {
  return typeof message === 'string' && INTERNAL_MARKERS.test(message);
}

/** A card decline, from Stripe's `code` / `decline_code`. */
function cardFailure(code: string): CheckoutFailure {
  const message = CARD_MESSAGES[code] || MESSAGES.cardFallback;
  const blocked = code === 'fraudulent';
  return {
    message,
    // A blocked card will not work again; every other decline may.
    retryable: !blocked,
    code: `card_${code || 'unknown'}`,
  };
}

/**
 * Translate anything Stripe (or the network under it) can throw.
 *
 * Order matters: the SDK sets both `type` and `statusCode`, and the specific
 * codes are checked before the generic type, so `idempotency_key_in_use`
 * (a 409 StripeInvalidRequestError) is not mistaken for an invalid request.
 */
export function describeStripeFailure(err: any): CheckoutFailure {
  const type = (err && err.type) || '';
  const code = (err && (err.code || (err.raw && err.raw.code))) || '';
  const declineCode =
    (err && (err.decline_code || (err.raw && err.raw.decline_code))) || '';
  const statusCode = err && err.statusCode;

  // The customer double-submitted and Stripe is still working on the first one.
  // Probed 2026-10-14: the loser of two concurrent requests with one key gets
  // exactly this, so it is the double-click path, not a broken request.
  if (code === 'idempotency_key_in_use') {
    return { message: MESSAGES.alreadyProcessing, retryable: false, code: 'duplicate_submit_in_flight' };
  }

  // The same key replayed with different parameters: we know a previous attempt
  // exists but cannot see its outcome through this call.
  if (type === 'StripeIdempotencyError' || code === 'idempotency_error') {
    return { message: MESSAGES.alreadyProcessing, retryable: false, code: 'duplicate_submit_replay' };
  }

  // A decline: the one family whose own wording is written for a cardholder.
  if (type === 'StripeCardError' || statusCode === 402) {
    return cardFailure(code || declineCode);
  }

  // The network, not the card. The request may or may not have reached Stripe.
  if (
    type === 'StripeConnectionError' ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].indexOf(code) !== -1
  ) {
    return { message: MESSAGES.connection, retryable: true, code: 'connection' };
  }

  // Our fault, never the customer's — and the raw message names our key.
  if (type === 'StripeAuthenticationError' || type === 'StripePermissionError') {
    return { message: MESSAGES.unavailable, retryable: false, code: 'configuration' };
  }

  if (type === 'StripeRateLimitError') {
    return { message: MESSAGES.rateLimited, retryable: true, code: 'rate_limited' };
  }

  if (type === 'StripeInvalidRequestError') {
    if (code === 'amount_too_small' || code === 'parameter_invalid_integer') {
      // An app-side arithmetic problem: an empty or mis-priced bag reached the
      // charge call. The customer's action is to change the bag, not to retry.
      return { message: MESSAGES.belowMinimum, retryable: false, code: 'bad_amount' };
    }
    if (code === 'resource_missing') {
      return { message: MESSAGES.cardFallback, retryable: true, code: 'unknown_payment_method' };
    }
    return { message: MESSAGES.processorProblem, retryable: false, code: 'invalid_request' };
  }

  return { message: MESSAGES.processorProblem, retryable: true, code: type || 'unknown' };
}

/**
 * A PaymentIntent is created with `confirm: true`, so it comes back in one of
 * several states — and only one of them means the customer has paid.
 *
 * This is the guard for the worst bug found on day 22: a card that triggers 3-D
 * Secure returns `status: 'requires_action'` and **no error at all** (probed on
 * the live test key with `pm_card_threeDSecure2Required`). The old checkout
 * treated "the call resolved" as "the customer paid", wrote the order and sent
 * them to the confirmation page — a free order for every card needing
 * authentication.
 */
export function assertChargeSucceeded(intent: any): void {
  const status = intent && intent.status;

  if (status === 'succeeded') return;

  if (
    status === 'requires_action' ||
    status === 'requires_confirmation' ||
    status === 'requires_payment_method'
  ) {
    throw checkoutFailure({
      message: MESSAGES.authenticationRequired,
      retryable: false,
      code: 'authentication_required',
    });
  }

  if (status === 'processing') {
    throw checkoutFailure({ message: MESSAGES.processing, retryable: true, code: 'processing' });
  }

  if (status === 'canceled') {
    throw checkoutFailure({ message: MESSAGES.cancelled, retryable: false, code: 'cancelled' });
  }

  throw checkoutFailure({ message: MESSAGES.processorProblem, retryable: true, code: `charge_${status || 'missing'}` });
}

/**
 * The reference shown when the money moved but the order did not get written.
 */
export function chargedWithoutOrder(chargeId: string): CheckoutFailure {
  return {
    message: `${MESSAGES.chargedWithoutOrder} ${chargeId}.`,
    retryable: false,
    code: 'charged_without_order',
  };
}

/**
 * The idempotency key for one bag.
 *
 * Stripe replays the stored response for a repeated key, so this is what makes
 * a double-click charge once. It is built from **server-side** facts only —
 * the signed-in user and the ids of the cart rows being charged — and
 * deliberately NOT from the client-supplied payment method:
 *
 *   - a double-click runs `stripe.createPaymentMethod` twice, so the two
 *     requests carry different payment methods. A key containing the payment
 *     method would let both through and charge the customer twice, which is the
 *     expensive way to be wrong.
 *   - cart row ids are stable across a retry but new rows are created for the
 *     next purchase, so a genuine second order is never mistaken for a repeat.
 *
 * Because the parameters must match on a replay, a repeat that carries a
 * different payment method is refused by Stripe (probed 2026-10-14) rather than
 * charged — which the caller reports as `alreadyProcessing`.
 */
export function idempotencyKey(userId: string, cartItems: Array<{ id: string }>): string {
  const rows = cartItems
    .map((item) => item.id)
    .filter(Boolean)
    .sort()
    .join(',');
  return `checkout_${userId}_${rows}`;
}
