/* eslint-disable */
/**
 * Day 26 — the storefront's order vocabulary is a mirror of the backend's.
 *
 * `frontend/lib/orderStatus.js` restates the statuses, their labels, the happy
 * path and the legal edges that `sick-fits/backend/lib/orderStatus.ts` defines.
 * It cannot import the backend (TypeScript, separate package), so it is a
 * deliberate copy — and a copy nobody checks is a copy that drifts. This test
 * reads the backend file off disk and fails the moment the two disagree.
 *
 * It also proves the page-level promise that the customer's view is read-only:
 * neither order page contains a mutation, so there is no status control to
 * tamper with, and the query cannot even name another customer's orders.
 */
import fs from 'fs';
import path from 'path';
import {
  ORDER_STATUSES,
  STATUS_FLOW,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  formatOrderDate,
  isOrderStatus,
  isTerminal,
  nextStatuses,
  progressPercent,
  statusLabel
} from '../lib/orderStatus';

const BACKEND_STATUS = path.resolve(
  __dirname,
  '..',
  '..',
  'backend',
  'lib',
  'orderStatus.ts'
);

// Read CODE, not commentary: the backend file's comments quote status names.
const stripComments = src =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const backend = stripComments(fs.readFileSync(BACKEND_STATUS, 'utf8'));

const quoted = block =>
  (block.match(/'([^']*)'/g) || []).map(match => match.slice(1, -1));

const arrayAfter = (name, terminator) => {
  const start = backend.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const open = backend.indexOf('[', start);
  const close = backend.indexOf(terminator || ']', open);
  expect(close).toBeGreaterThan(open);
  return quoted(backend.slice(open, close));
};

const objectAfter = name => {
  const start = backend.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const open = backend.indexOf('{', start);
  const close = backend.indexOf('\n};', open);
  expect(close).toBeGreaterThan(open);
  return backend.slice(open, close);
};

describe('the frontend order lifecycle mirrors the backend', () => {
  it('has exactly the backend statuses', () => {
    expect(ORDER_STATUSES).toEqual(arrayAfter('ORDER_STATUSES', '] as const'));
  });

  it('uses the same human labels', () => {
    const block = objectAfter('STATUS_LABELS');
    const pairs = [...block.matchAll(/([A-Z_]+):\s*'([^']*)'/g)].map(m => [
      m[1],
      m[2]
    ]);
    expect(pairs.length).toBeGreaterThan(0);
    expect(STATUS_LABELS).toEqual(Object.fromEntries(pairs));
  });

  it('agrees on the happy path', () => {
    expect(STATUS_FLOW).toEqual(arrayAfter('STATUS_FLOW', '];'));
  });

  it('agrees on every legal edge', () => {
    const block = objectAfter('STATUS_TRANSITIONS');
    const edges = {};
    [...block.matchAll(/([A-Z_]+):\s*\[([^\]]*)\]/g)].forEach(m => {
      edges[m[1]] = quoted(m[2]);
    });
    expect(Object.keys(edges).sort()).toEqual(ORDER_STATUSES.slice().sort());
    expect(STATUS_TRANSITIONS).toEqual(edges);
  });
});

describe('the display helpers behave', () => {
  it('labels a known status and refuses to invent an unknown one', () => {
    expect(statusLabel('PAID')).toBe('Paid');
    expect(statusLabel('SHIPPED')).toBe('Status unknown');
    expect(statusLabel(undefined)).toBe('Status unknown');
  });

  it('only accepts real statuses', () => {
    expect(isOrderStatus('DELIVERED')).toBe(true);
    expect(isOrderStatus('delivered')).toBe(false);
    expect(isOrderStatus(null)).toBe(false);
  });

  it('reports final states from the same table the backend uses', () => {
    expect(isTerminal('DELIVERED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('PAID')).toBe(false);
    expect(nextStatuses('CREATED')).toEqual(['PAID', 'CANCELLED']);
    expect(nextStatuses('DELIVERED')).toEqual([]);
  });

  it('places an order on the happy path, and leaves a cancelled order off it', () => {
    expect(progressPercent('CREATED')).toBe(0);
    expect(progressPercent('PAID')).toBe(33);
    expect(progressPercent('FULFILLED')).toBe(67);
    expect(progressPercent('DELIVERED')).toBe(100);
    expect(progressPercent('CANCELLED')).toBe(0);
  });

  it('formats a date in UTC, and never renders "Invalid Date"', () => {
    expect(formatOrderDate('2022-12-11T20:16:13.797Z')).toBe('11 Dec 2022');
    expect(formatOrderDate('2026-10-18T00:30:00.000Z')).toBe('18 Oct 2026');
    expect(formatOrderDate(null)).toBe('Date unknown');
    expect(formatOrderDate('not-a-date')).toBe('Date unknown');
  });
});

describe('the customer pages are read-only', () => {
  const read = file => stripComments(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'));

  it('the history page asks for the session user, with no way to name another', () => {
    const src = read('pages/order.js');
    expect(src).toMatch(/authenticatedItem/);
    expect(src).toMatch(/orders\(orderBy: createdAt_DESC\)/);
    // No variables at all in the query document: nothing to tamper with.
    expect(src).not.toMatch(/query USER_ORDERS_QUERY\s*\(/);
    expect(src).not.toMatch(/\$userId|\$where|\$email/);
  });

  it('neither page contains a mutation or an order update', () => {
    ['pages/order.js', 'pages/order/[id].js'].forEach(file => {
      const src = read(file);
      expect(src).not.toMatch(/useMutation/);
      expect(src).not.toMatch(/mutation\s+\w*ORDER/);
      expect(src).not.toMatch(/updateOrder/);
    });
  });

  it('the single-order page reads status and the date it changed', () => {
    const src = read('pages/order/[id].js');
    expect(src).toMatch(/status\b/);
    expect(src).toMatch(/statusChangedAt/);
    expect(src).toMatch(/STATUS_FLOW/);
  });
});
