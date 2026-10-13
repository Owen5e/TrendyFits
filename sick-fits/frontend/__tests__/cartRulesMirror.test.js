/**
 * The frontend keeps a mirror of the backend's cart rules so the controls can
 * disable themselves before a customer hits a wall (see the header of
 * `lib/cartLines.js`). A mirror that nobody checks is just a copy that will
 * drift, so this test reads `sick-fits/backend/lib/cartRules.ts` off disk and
 * fails the moment the two disagree about a number.
 *
 * It deliberately asserts values and shapes, not behaviour: the backend's own
 * executable coverage lives in `sick-fits/backend/test/cart-rules.test.js`
 * (`npm run test:cart`), which is where the rules are actually run.
 */
import fs from 'fs';
import path from 'path';
import { DEFAULT_LINE_LIMIT, MIN_LINE_QUANTITY } from '../lib/cartLines';

const BACKEND_RULES = path.resolve(__dirname, '..', '..', 'backend', 'lib', 'cartRules.ts');

// Read CODE, not commentary: the file's own comments quote the numbers.
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const constantValue = (src, name) => {
  const match = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
};

describe('frontend cart rules mirror the backend', () => {
  const raw = fs.readFileSync(BACKEND_RULES, 'utf8');
  const src = stripComments(raw);

  it('is reading the real backend rules file', () => {
    expect(raw).toMatch(/export function lineLimit/);
    expect(raw).toMatch(/export function mergeQuantity/);
  });

  it('agrees on the default line limit', () => {
    expect(constantValue(src, 'DEFAULT_LINE_LIMIT')).toBe(DEFAULT_LINE_LIMIT);
  });

  it('agrees on the minimum line quantity', () => {
    expect(constantValue(src, 'MIN_LINE_QUANTITY')).toBe(MIN_LINE_QUANTITY);
  });

  it('merges by maximum, never by sum — on both sides', () => {
    // The merge rule has to be identical in both places, or the cart the browser
    // shows and the cart the server stores disagree about what "merged" means.
    expect(src).toMatch(/Math\.max\(/);
    const frontend = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'cartLines.js'), 'utf8'));
    expect(frontend).toMatch(/Math\.max\(/);
  });
});
