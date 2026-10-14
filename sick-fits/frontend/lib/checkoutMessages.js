/**
 * Day 22 — the browser's half of the checkout failure vocabulary.
 *
 * Two kinds of failure never reach the server at all, so the server's
 * translation in `sick-fits/backend/lib/checkoutErrors.ts` cannot speak for them:
 *
 *   1. Stripe.js refusing a card in the browser (`createPaymentMethod`) — a bad
 *      number, an expired date, a card the bank declines before a charge is
 *      ever attempted. These arrive as a Stripe.js error object with
 *      `type: 'card_error' | 'validation_error' | 'api_connection_error' | ...`.
 *   2. The request to our own GraphQL API failing on the way out, or coming back
 *      with a failure we wrote. An Apollo error carries `graphQLErrors` and/or
 *      `networkError`, not a Stripe shape.
 *
 * The catalogue below is a mirror of the backend's `MESSAGES`, deliberately and
 * verbatim: a customer who is declined in the browser and a customer declined by
 * the server must read the same sentence. `__tests__/checkoutMessagesMirror.test.js`
 * reads the backend file off disk and fails the moment the two drift.
 *
 * The rule from the backend holds here too: a raw Stripe string is shown only
 * when it is a whitelisted CARD message. Everything else gets our own words.
 */

export const MESSAGES = {
  notSignedIn:
    'Please sign in before checking out — your bag is saved and waiting.',

  emptyCart: 'Your bag is empty, so there is nothing to pay for yet.',

  belowMinimum:
    'Your bag total is below the smallest amount the card processor will accept. Add another item and try again.',

  alreadyProcessing:
    'We are already processing a payment for this bag. Do not click again — if your order does not turn up in a moment, check your orders page.',

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

  cardFallback: 'Your card could not be charged. Please try a different card.',

  chargedWithoutOrder:
    'Your payment went through, but we could not write the order down. You have been charged once — please contact us with reference',

  // Browser-only: Stripe.js could not read the card fields at all.
  cardUnreadable:
    'Those card details could not be read. Check the number, the expiry date and the security code, then try again.',
};

/** Mirror of the backend's CARD_MESSAGES. Same keys, same sentences. */
export const CARD_MESSAGES = {
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
 * Mirror of the backend's INTERNAL_MARKERS: the shapes that mean "this sentence
 * was written for a developer". Kept identical on purpose, and asserted to be
 * identical by the mirror test.
 */
export const INTERNAL_MARKERS =
  /sk_(test|live)|pk_(test|live)|pi_[A-Za-z0-9]|pm_[A-Za-z0-9]|https?:\/\/|idempoten|Setup Intent|SetupIntent|amount_too_small|parameter_invalid|No such |Invalid API Key|Stripe|stripe/i;

export function isInternalMessage(message) {
  return typeof message === 'string' && INTERNAL_MARKERS.test(message);
}

const failure = (message, retryable, code) => ({ message, retryable, code });

/**
 * Every sentence a customer is allowed to read. Recognised positively, rather
 * than by trying to spot the developer ones: a message either IS one of ours or
 * it is replaced. The raw text of a JavaScript error ("Cannot read properties of
 * undefined") contains no marker we could list, and must never be shown.
 */
const OUR_SENTENCES = new Set([...Object.values(MESSAGES), ...Object.values(CARD_MESSAGES)]);

const isOurSentence = message =>
  typeof message === 'string' && OUR_SENTENCES.has(message) && !isInternalMessage(message);

function cardFailure(code) {
  const message = CARD_MESSAGES[code] || MESSAGES.cardFallback;
  return failure(message, code !== 'fraudulent', `card_${code || 'unknown'}`);
}

/**
 * Anything the browser can throw on the way to a paid order, in customer words.
 */
export function describeCheckoutFailure(err) {
  if (!err) return failure(MESSAGES.processorProblem, true, 'empty_error');

  const stripeType = err.type;
  const code = err.code || err.decline_code || '';

  // --- Stripe.js ------------------------------------------------------------
  if (stripeType === 'card_error') {
    return cardFailure(code);
  }

  if (stripeType === 'validation_error') {
    return failure(MESSAGES.cardUnreadable, true, 'card_unreadable');
  }

  if (stripeType === 'api_connection_error') {
    return failure(MESSAGES.connection, true, 'connection');
  }

  if (stripeType === 'rate_limit_error') {
    return failure(MESSAGES.rateLimited, true, 'rate_limited');
  }

  if (stripeType === 'authentication_error') {
    return failure(MESSAGES.unavailable, false, 'configuration');
  }

  if (stripeType === 'invalid_request_error' || stripeType === 'api_error') {
    return failure(MESSAGES.processorProblem, true, stripeType);
  }

  // --- Apollo / our own API -------------------------------------------------
  // The request never landed, so the outcome of any charge is unknown.
  if (err.networkError) {
    return failure(MESSAGES.connection, true, 'connection');
  }

  const graphMessage =
    (err.graphQLErrors && err.graphQLErrors.length && err.graphQLErrors[0].message) || '';

  if (graphMessage) {
    // A message from our own resolver is already written for a customer; a
    // message from anywhere else is not, and is replaced.
    //
    // One of ours carries a value that would otherwise look internal: the
    // "money taken, order not written" message ends in the charge reference, and
    // a charge reference is exactly what the customer must be able to quote. So
    // it is recognised by its opening words rather than by the leak filter.
    if (graphMessage.indexOf(MESSAGES.chargedWithoutOrder) === 0) {
      return failure(graphMessage, false, 'charged_without_order');
    }
    if (isOurSentence(graphMessage)) {
      return failure(graphMessage, true, 'server_message');
    }
    return failure(MESSAGES.processorProblem, false, 'server_internal');
  }

  // A sentence of ours that arrived unwrapped, or nothing we can use. A raw
  // JavaScript error message is written for a developer and is replaced.
  if (isOurSentence(err.message)) {
    return failure(err.message, true, 'client_message');
  }

  return failure(MESSAGES.processorProblem, true, 'unknown');
}

/**
 * The response came back with no order in it.
 *
 * `order.data.checkout.id` on a null payload threw a TypeError, which the
 * customer saw as a blank "cannot read properties of null" — after money may
 * already have moved. There is no way to tell from here, so the words say so.
 */
export const missingOrderFailure = () =>
  failure(MESSAGES.connection, true, 'missing_order');

export const chargedWithoutOrderFailure = (chargeId) =>
  failure(`${MESSAGES.chargedWithoutOrder} ${chargeId || 'the reference on your bank statement'}.`, false, 'charged_without_order');
