/* eslint-disable */
/**
 * Day 21 — the anonymous cart and the rule that folds it into an account.
 *
 * Task: "Anonymous cart: a localStorage cart that merges into the server cart on
 * sign-in, with a merge rule you can explain out loud."
 * Acceptance: "Add items signed out, sign in, and nothing is lost or double-counted."
 *
 * The acceptance check is the first describe block below, stated as arithmetic:
 * every case where the two carts disagree, and every case where they agree.
 */
import { MockedProvider } from '@apollo/client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddToCart from '../components/AddToCart';
import Cart from '../components/Cart';
import MergeAnonymousCart, { MERGE_CART_MUTATION } from '../components/MergeAnonymousCart';
import Nav from '../components/Nav';
import { CURRENT_USER_QUERY } from '../components/User';
import {
  LOCAL_CART_KEY,
  LOCAL_CART_MAX_LINES,
  mergeForDisplay,
  mergeLines,
  readLocalCart,
  sanitiseLines,
  writeLocalCart
} from '../lib/anonCart';
import { CartStateProvider } from '../lib/cartState';
import formatMoney from '../lib/formatMoney';

jest.mock('../components/Checkout', () => ({
  Checkout: () => <div data-testid="checkout-stub" />
}));

const photo = { image: { publicUrlTransformed: 'hondo.jpg' } };

const product = (overrides = {}) => ({
  id: 'p1',
  name: 'Yeti Hondo',
  price: 3423,
  stock: 5,
  photo,
  ...overrides
});

const localLine = (overrides = {}) => ({
  id: 'p1',
  quantity: 2,
  product: product(),
  ...overrides
});

const serverLine = (overrides = {}) => ({
  __typename: 'CartItem',
  id: 'cart-1',
  quantity: 1,
  product: { __typename: 'Product', ...product() },
  ...overrides
});

const userMock = cart => ({
  request: { query: CURRENT_USER_QUERY },
  result: {
    data: {
      authenticatedItem: {
        __typename: 'User',
        id: 'u1',
        email: 'owen@example.com',
        name: 'Owen',
        cart
      }
    }
  }
});

const signedOutMocks = (times = 3) =>
  Array.from({ length: times }, () => ({
    request: { query: CURRENT_USER_QUERY },
    result: { data: { authenticatedItem: null } }
  }));

beforeEach(() => {
  window.localStorage.clear();
});

/**
 * React 18 + RTL only flush state and promise continuations created outside a user
 * event when `act()` runs. A merge is triggered by the user query resolving rather
 * than by a click, so the test has to give it that flush before asserting — the
 * response itself is delivered either way (verified by instrumenting the mock link:
 * the request matches and the observable emits).
 */
const flush = async (ms = 50) => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

describe('the merge rule — nothing lost, nothing double-counted', () => {
  it('a line added only while signed out is carried into the bag intact', () => {
    const { items } = mergeLines([], [localLine({ quantity: 2 })]);
    expect(items).toEqual([{ productId: 'p1', quantity: 2 }]);
  });

  it('one added in BOTH places merges to the larger quantity, never the sum', () => {
    // 1 signed in + 1 signed out is 1, not 2 — the acceptance check, in numbers
    expect(mergeLines([serverLine({ quantity: 1 })], [localLine({ quantity: 1 })]).items).toEqual([]);
    // 1 on the server, 3 in the browser → 3 (not 4, not 1)
    expect(mergeLines([serverLine({ quantity: 1 })], [localLine({ quantity: 3 })]).items).toEqual([
      { productId: 'p1', quantity: 3 }
    ]);
    // 4 on the server, 2 in the browser → nothing to write at all
    expect(mergeLines([serverLine({ quantity: 4 })], [localLine({ quantity: 2 })]).items).toEqual([]);
  });

  it('a line the server already has is never deleted by a merge', () => {
    const { items } = mergeLines([serverLine({ quantity: 3 })], []);
    expect(items).toEqual([]);
  });

  it('still respects the product ceiling', () => {
    const capped = mergeLines([], [localLine({ quantity: 9, product: product({ stock: 4 }) })]);
    expect(capped.items).toEqual([{ productId: 'p1', quantity: 4 }]);
  });

  it('reports the lines it cannot send instead of dropping them silently', () => {
    const { items, skipped } = mergeLines([], [{ id: '', quantity: 2, product: null }]);
    expect(items).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('no product id');
  });
});

describe('what the drawer shows while a merge is pending', () => {
  it('shows the larger quantity per product and keeps browser-only lines visible', () => {
    const lines = mergeForDisplay(
      [serverLine({ quantity: 1 })],
      [localLine({ quantity: 3 }), { id: 'p2', quantity: 1, product: product({ id: 'p2', name: 'Socks' }) }]
    );

    expect(lines).toHaveLength(2);
    expect(lines.find(line => line.id === 'cart-1').quantity).toBe(3);
    expect(lines.find(line => line.id === 'p2').local).toBe(true);
  });
});

describe('localStorage is not trusted', () => {
  it('round-trips a cart', () => {
    writeLocalCart([localLine()]);
    expect(readLocalCart()).toHaveLength(1);
    expect(readLocalCart()[0].quantity).toBe(2);
  });

  it('survives garbage, null and a missing key', () => {
    window.localStorage.setItem(LOCAL_CART_KEY, 'not json{');
    expect(readLocalCart()).toEqual([]);
    window.localStorage.setItem(LOCAL_CART_KEY, '{"cart":1}');
    expect(readLocalCart()).toEqual([]);
    window.localStorage.removeItem(LOCAL_CART_KEY);
    expect(readLocalCart()).toEqual([]);
  });

  it('drops entries a line cannot be built from', () => {
    expect(sanitiseLines([{ quantity: 2 }, { id: 'p1' }, { id: 'p1', quantity: 0 }, null, 'x'])).toEqual([]);
    expect(sanitiseLines([{ id: 'p1', quantity: '2' }])).toHaveLength(1);
  });

  it('folds duplicate products rather than letting one payload double-count', () => {
    const clean = sanitiseLines([
      { id: 'p1', quantity: 1, product: product() },
      { id: 'p1', quantity: 3, product: product() }
    ]);
    expect(clean).toHaveLength(1);
    expect(clean[0].quantity).toBe(3);
  });

  it('refuses an unbounded payload', () => {
    const flood = Array.from({ length: LOCAL_CART_MAX_LINES + 20 }, (unused, i) => ({
      id: `p${i}`,
      quantity: 1,
      product: product({ id: `p${i}` })
    }));
    expect(sanitiseLines(flood).length).toBeLessThanOrEqual(LOCAL_CART_MAX_LINES);
  });
});

const renderWithProviders = (node, mocks) =>
  render(
    <MockedProvider mocks={mocks}>
      <CartStateProvider>
        {node}
      </CartStateProvider>
    </MockedProvider>
  );

describe('<AddToCart/> signed out', () => {
  it('keeps the bag in the browser instead of sending the customer to sign in', async () => {
    renderWithProviders(<AddToCart id="p1" product={product()} />, signedOutMocks());

    fireEvent.click(await screen.findByRole('button', { name: /ADD TO BAG/i }));

    await screen.findByText(/sign in to check out/i);
    const stored = JSON.parse(window.localStorage.getItem(LOCAL_CART_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'p1', quantity: 1 });
    expect(stored[0].product.name).toBe('Yeti Hondo');
  });

  it('tops up the line it already holds rather than adding a second one', async () => {
    writeLocalCart([localLine({ quantity: 1 })]);
    renderWithProviders(<AddToCart id="p1" product={product()} />, signedOutMocks());

    fireEvent.click(await screen.findByRole('button', { name: /ADD TO BAG/i }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(LOCAL_CART_KEY));
      expect(stored).toHaveLength(1);
      expect(stored[0].quantity).toBe(2);
    });
  });
});

describe('<Cart/> signed out', () => {
  it('renders the browser cart, prices it, and offers sign-in instead of checkout', async () => {
    writeLocalCart([localLine({ quantity: 2 })]);
    renderWithProviders(<Cart />, signedOutMocks());

    await screen.findByTestId('cart-lines');
    expect(screen.getByTestId('cart-total')).toHaveTextContent(formatMoney(3423 * 2));
    expect(screen.getByTestId('signin-to-checkout')).toBeInTheDocument();
    expect(screen.queryByTestId('checkout-stub')).not.toBeInTheDocument();
  });

  it('lets a signed-out customer change and remove quantities', async () => {
    writeLocalCart([localLine({ quantity: 2 })]);
    renderWithProviders(<Cart />, signedOutMocks());

    await screen.findByTestId('cart-lines');
    fireEvent.click(screen.getByLabelText('Increase quantity of Yeti Hondo'));

    await waitFor(() =>
      expect(screen.getByTestId('cart-total')).toHaveTextContent(formatMoney(3423 * 3))
    );
    expect(JSON.parse(window.localStorage.getItem(LOCAL_CART_KEY))[0].quantity).toBe(3);

    fireEvent.click(screen.getByTestId('remove-from-cart'));
    await screen.findByRole('heading', { name: /your cart is empty/i });
    expect(JSON.parse(window.localStorage.getItem(LOCAL_CART_KEY))).toEqual([]);
  });
});

describe('<MergeAnonymousCart/>', () => {
  it('does nothing while signed out', async () => {
    writeLocalCart([localLine({ quantity: 2 })]);
    renderWithProviders(<MergeAnonymousCart />, signedOutMocks());

    await flush();
    expect(screen.queryByTestId('merge-failed')).not.toBeInTheDocument();
    expect(readLocalCart()).toHaveLength(1); // untouched, still the only copy
  });

  it('moves the browser cart into the account on sign-in and then clears it', async () => {
    writeLocalCart([localLine({ quantity: 3 })]);
    renderWithProviders(<MergeAnonymousCart />, [
      userMock([serverLine({ quantity: 1 })]),
      // The mock only matches if the payload is EXACTLY the merged quantity: the
      // server holds 1, the browser holds 3, so 3 is written — never 4.
      {
        request: { query: MERGE_CART_MUTATION, variables: { items: [{ productId: 'p1', quantity: 3 }] } },
        result: { data: { mergeCart: [{ __typename: 'CartItem', id: 'cart-1', quantity: 3 }] } }
      },
      userMock([serverLine({ quantity: 3 })])
    ]);

    await flush();
    await waitFor(() => expect(readLocalCart()).toEqual([]));
    expect(screen.queryByTestId('merge-failed')).not.toBeInTheDocument();
  });

  it('keeps the browser cart and offers a retry when the merge fails', async () => {
    writeLocalCart([localLine({ quantity: 2 })]);
    renderWithProviders(<MergeAnonymousCart />, [
      userMock([]),
      {
        request: { query: MERGE_CART_MUTATION, variables: { items: [{ productId: 'p1', quantity: 2 }] } },
        result: { errors: [{ message: 'Could not merge your bag. Please try again.' }] }
      },
      userMock([])
    ]);

    await flush();
    await screen.findByTestId('merge-failed');
    expect(screen.getByTestId('merge-retry')).toBeInTheDocument();
    expect(readLocalCart()).toHaveLength(1); // nothing lost
  });
});

describe('<Nav/> badge', () => {
  it('counts the browser cart when signed out', async () => {
    writeLocalCart([localLine({ quantity: 2 })]);
    renderWithProviders(<Nav />, signedOutMocks());

    await screen.findAllByLabelText('Open bag');
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });
});
