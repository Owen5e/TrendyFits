/* eslint-disable */
/**
 * Day 26 — the order history page and the single-order page, rendered.
 *
 * These are render tests, not proof of access control: the query shapes and the
 * backend filter are proven in `backend/test/order-status.test.js` and
 * `orderStatusMirror.test.js`. What is checked here is what the customer
 * actually sees for each of the four states the page can be in — signed out,
 * no orders, orders with statuses, and an order that is not theirs to see.
 */
import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import OrdersPage, { USER_ORDERS_QUERY } from '../pages/order';
import SingleOrderPage, {
  SINGLE_ORDER_QUERY
} from '../pages/order/[id]';

let mockQuery = {};
jest.mock('next/router', () => ({
  useRouter: () => ({ query: mockQuery })
}));

const order = (overrides = {}) => ({
  __typename: 'Order',
  id: 'ord1',
  charge: 'ch_123',
  total: 40000,
  status: 'PAID',
  createdAt: '2022-12-11T20:16:13.797Z',
  statusChangedAt: '2022-12-12T09:00:00.000Z',
  items: [
    {
      __typename: 'OrderItem',
      id: 'oi1',
      name: 'Yeti Hondo',
      description: 'soo nice',
      price: 3423,
      quantity: 2,
      photo: { __typename: 'ProductImage', image: { publicUrlTransformed: 'hondo.jpg' } }
    },
    {
      __typename: 'OrderItem',
      id: 'oi2',
      name: 'KITH Hoodie',
      description: 'warm',
      price: 5000,
      quantity: 1,
      // A missing photo is a real case (day 22): the tile must not break.
      photo: null
    }
  ],
  ...overrides
});

const historyMock = (authenticatedItem) => [
  {
    request: { query: USER_ORDERS_QUERY },
    result: { data: { authenticatedItem } }
  }
];

const singleMock = (data, id = 'ord1') => [
  {
    request: { query: SINGLE_ORDER_QUERY, variables: { id } },
    result: { data }
  }
];

const user = (orders) => ({
  __typename: 'User',
  id: 'user-1',
  name: 'Ada',
  email: 'ada@example.com',
  orders
});

describe('<OrdersPage/>', () => {
  afterEach(() => {
    mockQuery = {};
  });

  it('asks a signed-out visitor to sign in instead of showing "0 orders"', async () => {
    render(
      <MockedProvider mocks={historyMock(null)}>
        <OrdersPage />
      </MockedProvider>
    );
    const prompt = await screen.findByTestId('orders-signin');
    expect(prompt).toHaveTextContent('Sign in to see your orders');
  });

  it('shows a real empty state for a customer with no orders', async () => {
    render(
      <MockedProvider mocks={historyMock(user([]))}>
        <OrdersPage />
      </MockedProvider>
    );
    expect(await screen.findByTestId('orders-empty')).toBeInTheDocument();
    expect(screen.getByText('No orders yet')).toBeInTheDocument();
    expect(screen.queryByTestId('order-card')).not.toBeInTheDocument();
  });

  it('lists each order with its status in words, its date and its totals', async () => {
    render(
      <MockedProvider
        mocks={historyMock(
          user([
            order({ id: 'ord1', status: 'PAID' }),
            order({ id: 'ord2', status: 'DELIVERED', createdAt: '2022-11-01T10:00:00.000Z' })
          ])
        )}
      >
        <OrdersPage />
      </MockedProvider>
    );

    const cards = await screen.findAllByTestId('order-card');
    expect(cards).toHaveLength(2);
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('11 Dec 2022')).toBeInTheDocument();
    expect(screen.getByText('1 Nov 2022')).toBeInTheDocument();
    // Totals and item counts come from the order, not from a hardcoded row.
    // formatMoney drops the cents on a whole-dollar amount.
    expect(screen.getAllByText('$400')[0]).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent('3');
  });

  it('does not turn a missing product photo into a broken tile', async () => {
    render(
      <MockedProvider mocks={historyMock(user([order()]))}>
        <OrdersPage />
      </MockedProvider>
    );
    const cards = await screen.findAllByTestId('order-card');
    // One real image, one text placeholder — never a broken src.
    expect(cards[0].querySelectorAll('img')).toHaveLength(1);
    expect(cards[0].querySelectorAll('.no-photo')).toHaveLength(1);
  });
});

describe('<SingleOrderPage/>', () => {
  afterEach(() => {
    mockQuery = {};
  });

  it('draws the status timeline up to where the order has got to', async () => {
    mockQuery = { id: 'ord1' };
    render(
      <MockedProvider mocks={singleMock({ order: order({ status: 'PAID' }) })}>
        <SingleOrderPage />
      </MockedProvider>
    );

    expect(await screen.findByTestId('order-status')).toHaveTextContent('Paid');
    const timeline = screen.getByTestId('order-timeline');
    ['Created', 'Paid', 'Fulfilled', 'Delivered'].forEach(step => {
      expect(timeline).toHaveTextContent(step);
    });
    expect(timeline.querySelectorAll('li.done')).toHaveLength(2);
    expect(timeline.querySelector('li.current')).toHaveTextContent('Paid');
  });

  it('shows a cancelled order as cancelled, not as progress', async () => {
    mockQuery = { id: 'ord1' };
    render(
      <MockedProvider mocks={singleMock({ order: order({ status: 'CANCELLED' }) })}>
        <SingleOrderPage />
      </MockedProvider>
    );
    expect(await screen.findByTestId('order-status')).toHaveTextContent('Cancelled');
    expect(screen.getByTestId('order-cancelled')).toBeInTheDocument();
    expect(screen.queryByTestId('order-timeline')).not.toBeInTheDocument();
  });

  it('says so plainly when the order is not theirs to see', async () => {
    mockQuery = { id: 'not-mine' };
    render(
      <MockedProvider mocks={singleMock({ order: null }, 'not-mine')}>
        <SingleOrderPage />
      </MockedProvider>
    );
    expect(await screen.findByTestId('order-not-found')).toHaveTextContent(
      'We could not find that order'
    );
  });
});
