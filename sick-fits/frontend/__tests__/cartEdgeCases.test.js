/* eslint-disable */
/**
 * Day 20 — the cart edge cases as the customer meets them.
 *
 * `cartLines.test.js` proves the rules; this file proves the screens use them:
 * a quantity change really calls the server and the total really moves, the +
 * really stops at the product's stock, removing the last line really leaves an
 * empty cart, and a refusal really reaches the page instead of looking broken.
 */
import { MockedProvider } from '@apollo/client/testing';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRouter } from 'next/router';
import wait from 'waait';
import AddToCart, { ADD_TO_CART_MUTATION } from '../components/AddToCart';
import Cart, { UPDATE_CART_ITEM_MUTATION } from '../components/Cart';
import RemoveFromCart, { REMOVE_FROM_CART_MUTATION } from '../components/RemoveFromCart';
import { CURRENT_USER_QUERY } from '../components/User';
import { CartStateProvider } from '../lib/cartState';
import formatMoney from '../lib/formatMoney';

// Cart renders <Checkout/>, which builds a Stripe Elements tree and needs a real
// publishable key. The checkout flow is day 22's task; here it is a stub so the
// cart itself is what is under test.
jest.mock('../components/Checkout', () => ({
  Checkout: () => <div data-testid="checkout-stub" />
}));

const photo = {
  __typename: 'ProductImage',
  image: {
    __typename: 'CloudinaryImage_File',
    publicUrlTransformed: 'hondo.jpg'
  }
};

const product = (overrides = {}) => ({
  __typename: 'Product',
  id: 'p1',
  name: 'Yeti Hondo',
  price: 3423,
  stock: 5,
  description: 'soo nice',
  photo,
  ...overrides
});

const cartLine = (overrides = {}) => ({
  __typename: 'CartItem',
  id: 'cart-1',
  quantity: 2,
  product: product(),
  ...overrides
});

const socks = () =>
  cartLine({ id: 'cart-2', quantity: 1, product: product({ id: 'p2', name: 'Socks', price: 500 }) });

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

const signedOutMock = () => ({
  request: { query: CURRENT_USER_QUERY },
  result: { data: { authenticatedItem: null } }
});

// The user query polls, so a mock is consumed on every fetch; give each test a
// few copies of the same answer rather than letting the last one run dry.
const userMocks = (cart, times = 3) => Array.from({ length: times }, () => userMock(cart));

const renderCart = mocks =>
  render(
    <MockedProvider mocks={mocks}>
      <CartStateProvider>
        <Cart />
      </CartStateProvider>
    </MockedProvider>
  );

beforeEach(() => {
  // The browser cart (day 21) lives in localStorage; a leftover line from an
  // earlier test would show up in these signed-in renders.
  window.localStorage.clear();
});

describe('<Cart/> — price recalculation', () => {
  it('prices each line, totals them, and recalculates after a quantity change', async () => {
    const before = [cartLine(), socks()];
    const after = [cartLine({ quantity: 3 }), socks()];

    renderCart([
      userMock(before),
      {
        request: { query: UPDATE_CART_ITEM_MUTATION, variables: { id: 'cart-1', quantity: 3 } },
        result: {
          data: {
            updateCartItem: {
              __typename: 'CartItem',
              id: 'cart-1',
              quantity: 3,
              product: product()
            }
          }
        }
      },
      userMock(after),
      userMock(after)
    ]);

    await screen.findByTestId('cart-lines');
    expect(screen.getByTestId('cart-total')).toHaveTextContent(formatMoney(3423 * 2 + 500));

    fireEvent.click(screen.getByLabelText('Increase quantity of Yeti Hondo'));

    await waitFor(() =>
      expect(screen.getByTestId('cart-total')).toHaveTextContent(formatMoney(3423 * 3 + 500))
    );
    expect(screen.getByTestId('cart-summary')).toHaveTextContent('4 items in 2 lines');
  });
});

describe('<Cart/> — max stock', () => {
  it('disables + at the product stock and says why', async () => {
    renderCart(userMocks([cartLine({ quantity: 5, product: product({ stock: 5 }) })]));

    await screen.findByTestId('cart-lines');
    const increase = screen.getByLabelText('Increase quantity of Yeti Hondo');
    expect(increase).toBeDisabled();
    expect(screen.getByTestId('line-limit-note')).toHaveTextContent('Only 5 per order');
    expect(screen.getByTestId('quantity-value')).toHaveTextContent('5');
  });

  it('stops a decrement at one and points at remove instead', async () => {
    renderCart(userMocks([cartLine({ quantity: 1 })]));

    await screen.findByTestId('cart-lines');
    const decrease = screen.getByLabelText('Decrease quantity of Yeti Hondo');
    expect(decrease).toBeDisabled();
    expect(decrease).toHaveAttribute('title', 'Use remove to take this out of your bag');
  });
});

describe('<Cart/> — remove item and the empty cart', () => {
  it('empties the cart when the last line is removed', async () => {
    renderCart([
      userMock([cartLine()]),
      {
        request: { query: REMOVE_FROM_CART_MUTATION, variables: { id: 'cart-1' } },
        result: { data: { removeFromCart: { __typename: 'CartItem', id: 'cart-1' } } }
      },
      userMock([])
    ]);

    await screen.findByTestId('cart-lines');
    expect(screen.getByTestId('cart-total')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('remove-from-cart'));

    await screen.findByRole('heading', { name: /your cart is empty/i });
    expect(screen.queryByTestId('cart-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checkout-stub')).not.toBeInTheDocument();
  });

  it('shows a failed removal instead of doing nothing', async () => {
    renderCart([
      userMock([cartLine()]),
      {
        request: { query: REMOVE_FROM_CART_MUTATION, variables: { id: 'cart-1' } },
        result: { errors: [{ message: 'You do not have access to this resource' }] }
      }
    ]);

    await screen.findByTestId('cart-lines');
    fireEvent.click(screen.getByTestId('remove-from-cart'));

    await screen.findByTestId('remove-error');
    expect(screen.getByTestId('remove-error')).toHaveTextContent(
      'You do not have access to this resource'
    );
    expect(screen.getByTestId('cart-line')).toBeInTheDocument();
  });

  it('keeps a line whose product was deleted visible but out of the total', async () => {
    renderCart(
      userMocks([cartLine(), { __typename: 'CartItem', id: 'cart-9', quantity: 4, product: null }])
    );

    await screen.findByTestId('cart-lines');
    expect(screen.getByTestId('cart-line-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('cart-total')).toHaveTextContent(formatMoney(3423 * 2));
  });

  it('renders the empty panel for an empty cart, with no checkout and no total', async () => {
    renderCart(userMocks([]));

    await screen.findByRole('heading', { name: /your cart is empty/i });
    expect(screen.getByTestId('cart-summary')).toHaveTextContent('Your cart is empty');
    expect(screen.queryByTestId('cart-lines')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cart-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checkout-stub')).not.toBeInTheDocument();
  });
});

const renderAddToCart = mocks =>
  render(
    <MockedProvider mocks={mocks}>
      <CartStateProvider>
        <AddToCart id="p1" />
      </CartStateProvider>
    </MockedProvider>
  );

describe('<AddToCart/> — the ceiling', () => {
  it('refuses to add past the stock and never calls the mutation', async () => {
    renderAddToCart(userMocks([cartLine({ quantity: 5, product: product({ stock: 5 }) })]));

    const button = await screen.findByRole('button', { name: /MAX 5 IN BAG/i });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('add-to-cart-message')).toHaveTextContent('Only 5 per order');
  });

  it('adds below the ceiling and reports it', async () => {
    renderAddToCart([
      userMock([cartLine({ quantity: 4, product: product({ stock: 5 }) })]),
      {
        request: { query: ADD_TO_CART_MUTATION, variables: { id: 'p1' } },
        result: {
          data: {
            addToCart: { __typename: 'CartItem', id: 'cart-1', quantity: 5, product: product() }
          }
        }
      },
      userMock([cartLine({ quantity: 5, product: product({ stock: 5 }) })])
    ]);

    fireEvent.click(await screen.findByRole('button', { name: /ADD TO BAG/i }));
    await screen.findByText('Added to bag');
  });

  it('surfaces the server-side refusal when the screen let it through', async () => {
    const refusal = 'Only 5 of Yeti Hondo per order — your bag already has 5.';
    renderAddToCart([
      userMock([cartLine({ quantity: 1, product: product({ stock: 5 }) })]),
      {
        request: { query: ADD_TO_CART_MUTATION, variables: { id: 'p1' } },
        result: { errors: [{ message: refusal }] }
      }
    ]);

    fireEvent.click(await screen.findByRole('button', { name: /ADD TO BAG/i }));
    await waitFor(() =>
      expect(screen.getByTestId('add-to-cart-message')).toHaveTextContent(refusal)
    );
  });

  // CHANGED ON DAY 21: a signed-out customer used to be redirected to /signin.
  // They now keep the bag in the browser and it merges into the account on sign-in,
  // so this became the opposite assertion. The full signed-out path is covered in
  // __tests__/anonymousCart.test.js.
  it('keeps a signed-out customer on the product instead of sending them away', async () => {
    useRouter().push.mockClear();
    renderAddToCart([signedOutMock(), signedOutMock()]);

    fireEvent.click(await screen.findByRole('button', { name: /ADD TO BAG/i }));
    await wait(0);

    expect(useRouter().push).not.toHaveBeenCalled();
  });
});
