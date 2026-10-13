/* eslint-disable */

import { render, screen } from '@testing-library/react';
import { MockedProvider } from '@apollo/client/testing';
import Nav from '../components/Nav';
import { CURRENT_USER_QUERY } from '../components/User';
import { fakeCartItem, fakeUser, snapshotHTML } from '../lib/testUtils';
import { CartStateProvider } from '../lib/cartState';

// make some mocks for the user being logged out, logged in, logged in and with cart items

const notSignedInMocks = [
  {
    request: { query: CURRENT_USER_QUERY },
    result: { data: { authenticatedItem: null } }
  }
];

const signedInMocks = [
  {
    request: { query: CURRENT_USER_QUERY },
    result: { data: { authenticatedItem: fakeUser() } }
  }
];

const signedInWithCartMocks = [
  {
    request: { query: CURRENT_USER_QUERY },
    result: { data: { authenticatedItem: { ...fakeUser(), cart: [fakeCartItem()] } } }
  }
];

const renderNav = (mocks) =>
  render(
    <CartStateProvider>
      <MockedProvider mocks={mocks}>
        <Nav />
      </MockedProvider>
    </CartStateProvider>
  );

// The nav renders its links twice on purpose: once for the desktop bar and once
// inside the (always-mounted) mobile menu. Hence the getAllBy* queries.
describe('<Nav/>', () => {
  it('renders a minimal nav when signed out', () => {
    const { container } = renderNav(notSignedInMocks);

    // signed out: the account link goes to /signin and is labelled "Sign In"
    expect(screen.getByLabelText('Sign In')).toHaveAttribute('href', '/signin');
    expect(screen.getAllByText('SHOP ALL')[0]).toHaveAttribute('href', '/products');

    // no account-only links when signed out...
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();
    expect(screen.queryByText('Sell')).not.toBeInTheDocument();

    // ...but the bag IS reachable, because a signed-out visitor now has a cart of
    // their own (day 21) — it just lives in the browser until they sign in.
    expect(screen.getAllByText(/Bag/).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Open bag').length).toBeGreaterThan(0);

    expect(snapshotHTML(container)).toMatchSnapshot();
  });

  it('renders a full nav when signed in', async () => {
    const { container } = renderNav(signedInMocks);

    // wait for the mocked user to land
    await screen.findByLabelText('Account');

    expect(screen.getByLabelText('Account')).toHaveAttribute('href', '/account');
    expect(screen.getAllByText('Orders')[0]).toHaveAttribute('href', '/order');
    expect(screen.getAllByText('Sell')[0]).toHaveAttribute('href', '/sell');
    expect(screen.getAllByText('SHOP ALL')[0]).toHaveAttribute('href', '/products');
    expect(screen.getAllByText(/Bag/).length).toBeGreaterThan(0);

    expect(snapshotHTML(container)).toMatchSnapshot();
  });

  it('renders the amount of items in the cart', async () => {
    const { container } = renderNav(signedInWithCartMocks);

    await screen.findByLabelText('Account');

    // the mocked cart holds one item with a quantity of 3
    expect(screen.getAllByText('3')[0]).toBeInTheDocument();
    expect(snapshotHTML(container)).toMatchSnapshot();
  });
});
