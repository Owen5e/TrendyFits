import { useQuery } from '@apollo/client';
import gql from 'graphql-tag';
import Head from 'next/head';
import Link from 'next/link';
import styled from 'styled-components';
import ErrorMessage from '../components/ErrorMessage';
import OrderItemStyles from '../components/styles/OrderItemStyles';
import formatMoney from '../lib/formatMoney';
import {
  formatOrderDate,
  isOrderStatus,
  progressPercent,
  statusLabel
} from '../lib/orderStatus';

/**
 * Day 26 — order history for a signed-in customer.
 *
 * What this page may ask for is deliberately narrow: `authenticatedItem` is the
 * session's own user, and `orders` hangs off it. There is no variable and no
 * `where`, so there is nothing to tamper with to read someone else's history —
 * the query cannot even name another customer. The backend enforces the same
 * thing again (Order.read is a filter on the session's own id), and
 * `backend/test/order-status.test.js` proves that filter against real rows.
 *
 * The status shown here is read-only. A customer never gets a control that could
 * move it: moving an order is a staff act, and the API refuses it from a
 * customer's session anyway.
 */
export const USER_ORDERS_QUERY = gql`
  query USER_ORDERS_QUERY {
    authenticatedItem {
      ... on User {
        id
        email
        name
        orders(orderBy: createdAt_DESC) {
          id
          charge
          total
          status
          createdAt
          items {
            id
            name
            description
            price
            quantity
            photo {
              image {
                publicUrlTransformed
              }
            }
          }
        }
      }
    }
  }
`;

const OrderUl = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  grid-gap: 5rem;
  .no-photo {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 90px;
    padding: 0.5rem;
    background: var(--lightGray);
    color: var(--gray);
    font-size: 0.85rem;
    text-align: center;
  }
`;

const PageHeader = styled.div`
  margin-bottom: 3rem;
  h2 {
    margin-bottom: 0.5rem;
  }
  p {
    color: var(--gray);
  }
`;

const EmptyState = styled.div`
  border: 1px dashed var(--lightGray);
  padding: 4rem 2rem;
  text-align: center;
  background: white;
  border-radius: 8px;
  p {
    margin-bottom: 2rem;
    color: var(--gray);
  }
  a {
    display: inline-block;
    background: var(--red);
    color: white;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
  }
`;

const SignInPrompt = styled.div`
  max-width: 600px;
  margin: 4rem auto;
  padding: 3rem 2rem;
  text-align: center;
  background: white;
  border-radius: 8px;
  box-shadow: var(--bs);
  p {
    margin-bottom: 2rem;
  }
  a {
    display: inline-block;
    background: var(--red);
    color: white;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
  }
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
`;

const StatusBadge = styled.span`
  display: inline-block;
  padding: 0.35rem 0.9rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: bold;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: white;
  background: ${props => {
    switch (props['data-status']) {
      case 'PAID':
        return '#1f7a3f';
      case 'FULFILLED':
        return '#1c5fa8';
      case 'DELIVERED':
        return '#2c2c2c';
      case 'CANCELLED':
        return '#8b1a1a';
      default:
        return '#8a6d1f';
    }
  }};
`;

const Progress = styled.div`
  height: 6px;
  background: var(--lightGray);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 1.5rem;
  span {
    display: block;
    height: 100%;
    background: var(--red);
    width: ${props => `${props.percent}%`};
  }
`;

const DateLine = styled.p`
  margin: 0;
  color: var(--gray);
  font-size: 0.9rem;
`;

function countItemsInOrder(order) {
  return (order.items || []).reduce((tally, item) => tally + item.quantity, 0);
}

export { countItemsInOrder };

export default function OrdersPage() {
  const { data, error, loading } = useQuery(USER_ORDERS_QUERY);
  if (loading) return <p>Loading...</p>;
  if (error) return <ErrorMessage error={error} />;

  const user = data && data.authenticatedItem;
  const orders = (user && user.orders) || [];

  if (!user) {
    return (
      <SignInPrompt data-testid="orders-signin">
        <Head>
          <title>Your Orders | TrendyFits</title>
        </Head>
        <h2>Sign in to see your orders</h2>
        <p>Your order history belongs to your account, so we need you signed in.</p>
        <Link href="/signin">Sign In</Link>
      </SignInPrompt>
    );
  }

  return (
    <div>
      <Head>
        <title>Your Orders({orders.length}) | TrendyFits</title>
      </Head>
      <PageHeader>
        <h2>
          {orders.length === 0
            ? 'No orders yet'
            : `${orders.length} order${orders.length === 1 ? '' : 's'}`}
        </h2>
        {orders.length > 0 && (
          <p>
            Everything you have bought, newest first. Tap an order to see its items
            and where it has got to.
          </p>
        )}
      </PageHeader>

      {orders.length === 0 ? (
        <EmptyState data-testid="orders-empty">
          <p>When you buy something it will show up here, with its status.</p>
          <Link href="/products">Start shopping</Link>
        </EmptyState>
      ) : (
        <OrderUl>
          {orders.map(order => {
            const status = isOrderStatus(order.status) ? order.status : 'CREATED';
            const items = order.items || [];
            const cancelled = order.status === 'CANCELLED';
            return (
              <OrderItemStyles key={order.id} data-testid="order-card">
                <Link href={`/order/${order.id}`}>
                  <div>
                    <StatusRow>
                      <StatusBadge data-status={order.status}>
                        {statusLabel(order.status)}
                      </StatusBadge>
                      <DateLine>{formatOrderDate(order.createdAt)}</DateLine>
                    </StatusRow>
                    <div className="order-meta">
                      <p>
                        <strong>Items</strong>
                        {countItemsInOrder(order)}
                      </p>
                      <p>
                        <strong>Products</strong>
                        {items.length}
                      </p>
                      <p>
                        <strong>Total</strong>
                        {formatMoney(order.total)}
                      </p>
                    </div>
                    <div className="images">
                      {items.map(item => {
                        const src =
                          item.photo &&
                          item.photo.image &&
                          item.photo.image.publicUrlTransformed;
                        // A product photo is optional (day 22 found the checkout
                        // writing an order for one). A missing image must not be
                        // a broken tile on the customer's history.
                        return src ? (
                          <img
                            key={`image-${item.id}`}
                            src={src}
                            alt={item.name}
                          />
                        ) : (
                          <div className="no-photo" key={`image-${item.id}`}>
                            {item.name}
                          </div>
                        );
                      })}
                    </div>
                    {!cancelled && (
                      <Progress
                        percent={progressPercent(status)}
                        aria-hidden="true"
                      >
                        <span />
                      </Progress>
                    )}
                  </div>
                </Link>
              </OrderItemStyles>
            );
          })}
        </OrderUl>
      )}
    </div>
  );
}
