/* eslint-disable */
/**
 * Day 22 — the browser's checkout vocabulary is a mirror of the server's.
 *
 * `frontend/lib/checkoutMessages.js` restates the sentences in
 * `sick-fits/backend/lib/checkoutErrors.ts`, because two failures never reach the
 * server (Stripe.js refusing a card, our own API being unreachable) and still have
 * to be explained in the same words. A mirror nobody checks is a copy that will
 * drift, so this test reads the backend file off disk and fails the moment the two
 * disagree — the same pattern `cartRulesMirror.test.js` uses for the cart rules.
 *
 * It asserts sentences and shapes, not behaviour: the backend's executable
 * coverage is `sick-fits/backend/test/checkout-failure-paths.test.js`
 * (`npm run test:checkout`), against the live Stripe test key.
 */
import fs from 'fs';
import path from 'path';
import {
  CARD_MESSAGES,
  INTERNAL_MARKERS,
  MESSAGES,
  describeCheckoutFailure,
  isInternalMessage
} from '../lib/checkoutMessages';

const BACKEND_ERRORS = path.resolve(
  __dirname,
  '..',
  '..',
  'backend',
  'lib',
  'checkoutErrors.ts'
);

// Read CODE, not commentary: the file's own comments quote the sentences.
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const blockOf = (src, name) => {
  // The backend declares some catalogues with a type annotation
  // (`export const CARD_MESSAGES: { [code: string]: string } = {`), so the
  // matches may not assume `NAME = {`.
  const match = src.match(
    new RegExp(`export const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`)
  );
  if (!match) throw new Error(`${name} was not found in ${path.basename(BACKEND_ERRORS)}`);
  const pairs = {};
  const pair = /(\w+):\s*(['"])([\s\S]*?)\2/g;
  let entry = pair.exec(match[1]);
  while (entry) {
    pairs[entry[1]] = entry[3];
    entry = pair.exec(match[1]);
  }
  return pairs;
};

describe('the browser message catalogue mirrors the backend', () => {
  const raw = fs.readFileSync(BACKEND_ERRORS, 'utf8');
  const src = stripComments(raw);

  it('is reading the real backend file', () => {
    expect(raw).toMatch(/export function describeStripeFailure/);
    expect(raw).toMatch(/export function assertChargeSucceeded/);
    expect(raw).toMatch(/export function idempotencyKey/);
  });

  it('agrees on every shared sentence, word for word', () => {
    const backend = blockOf(src, 'MESSAGES');
    expect(Object.keys(backend).length).toBeGreaterThan(10);

    Object.entries(backend).forEach(([key, message]) => {
      expect(MESSAGES[key]).toBeDefined();
      expect(MESSAGES[key]).toBe(message);
    });
  });

  it('adds nothing beyond the one browser-only sentence', () => {
    const backendKeys = Object.keys(blockOf(src, 'MESSAGES'));
    const extra = Object.keys(MESSAGES).filter(key => !backendKeys.includes(key));
    expect(extra).toEqual(['cardUnreadable']);
  });

  it('mirrors the card decline sentences exactly, both ways', () => {
    const backend = blockOf(src, 'CARD_MESSAGES');
    expect(backend).toEqual(CARD_MESSAGES);
  });

  it('agrees on what counts as a developer message', () => {
    const match = src.match(/export const INTERNAL_MARKERS\s*=\s*(\/[\s\S]*?\/[gimsuy]*);/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(INTERNAL_MARKERS.toString());
  });
});

describe('the sentences we show', () => {
  const sentences = [...Object.values(MESSAGES), ...Object.values(CARD_MESSAGES)];

  it('are never Stripe internals', () => {
    sentences.forEach(sentence => {
      expect(INTERNAL_MARKERS.test(sentence)).toBe(false);
    });
  });

  it('are never empty and never shout', () => {
    sentences.forEach(sentence => {
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).toMatch(/^[A-Z]/);
    });
  });

  it('flags a real developer message and clears our own', () => {
    expect(isInternalMessage("Cannot read properties of null (reading 'id')")).toBe(false);
    expect(
      isInternalMessage(
        'There is currently another in-progress request using this Idempotent Key'
      )
    ).toBe(true);
    expect(isInternalMessage('Invalid API Key provided: sk_test_****0004')).toBe(true);
    expect(isInternalMessage(MESSAGES.connection)).toBe(false);
  });
});

describe('describeCheckoutFailure', () => {
  it('translates the Stripe.js card errors the browser can raise', () => {
    expect(describeCheckoutFailure({ type: 'card_error', code: 'card_declined' })).toEqual({
      message: CARD_MESSAGES.card_declined,
      retryable: true,
      code: 'card_card_declined'
    });
    expect(
      describeCheckoutFailure({ type: 'card_error', decline_code: 'insufficient_funds' }).message
    ).toBe(CARD_MESSAGES.insufficient_funds);
    expect(describeCheckoutFailure({ type: 'card_error', code: 'fraudulent' }).retryable).toBe(
      false
    );
  });

  it('falls back to our own words for a card code we have never seen', () => {
    const failure = describeCheckoutFailure({ type: 'card_error', code: 'some_new_code' });
    expect(failure.message).toBe(MESSAGES.cardFallback);
    expect(INTERNAL_MARKERS.test(failure.message)).toBe(false);
  });

  it('calls a card the browser could not read what it is', () => {
    expect(describeCheckoutFailure({ type: 'validation_error' }).message).toBe(
      MESSAGES.cardUnreadable
    );
  });

  it('treats a lost connection as an unknown outcome', () => {
    expect(describeCheckoutFailure({ type: 'api_connection_error' }).message).toBe(
      MESSAGES.connection
    );
    expect(describeCheckoutFailure({ networkError: new Error('Failed to fetch') }).message).toBe(
      MESSAGES.connection
    );
  });

  it('shows a server message that is already customer language', () => {
    const err = { graphQLErrors: [{ message: MESSAGES.alreadyProcessing }] };
    expect(describeCheckoutFailure(err).message).toBe(MESSAGES.alreadyProcessing);
  });

  it('replaces a server message that is not', () => {
    const err = {
      graphQLErrors: [{ message: 'Keys for idempotent requests can only be used with the same parameters' }]
    };
    expect(describeCheckoutFailure(err).message).toBe(MESSAGES.processorProblem);
  });

  it('keeps the charge reference when the money moved but the order was not written', () => {
    // The one message that must never be swallowed: it ends in a `pi_...`
    // reference, which the leak filter would otherwise treat as an internal.
    const err = {
      graphQLErrors: [
        { message: `${MESSAGES.chargedWithoutOrder} pi_3UQVfSRQOt2SJ0Iq0oXVtBov.` }
      ]
    };
    const caught = describeCheckoutFailure(err);
    expect(caught.code).toBe('charged_without_order');
    expect(caught.retryable).toBe(false);
    expect(caught.message).toMatch(/pi_3UQVfSRQOt2SJ0Iq0oXVtBov/);
  });

  it('replaces a raw JavaScript error instead of echoing it', () => {
    expect(describeCheckoutFailure(new Error('boom')).message).toBe(MESSAGES.processorProblem);
    expect(
      describeCheckoutFailure(new Error("Cannot read properties of undefined (reading 'id')")).message
    ).toBe(MESSAGES.processorProblem);
  });

  it('never returns a shape the form cannot print', () => {
    const oddities = [
      null,
      undefined,
      {},
      new Error('boom'),
      { type: 'api_error' },
      { type: 'rate_limit_error' },
      { type: 'authentication_error' },
      { graphQLErrors: [] },
      { graphQLErrors: [{ message: 'sk_test_leak' }] }
    ];

    oddities.forEach(err => {
      const failure = describeCheckoutFailure(err);
      expect(typeof failure.message).toBe('string');
      expect(failure.message.length).toBeGreaterThan(10);
      expect(typeof failure.retryable).toBe('boolean');
      expect(typeof failure.code).toBe('string');
      expect(INTERNAL_MARKERS.test(failure.message)).toBe(false);
    });
  });
});
