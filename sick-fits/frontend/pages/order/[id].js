import { useQuery } from '@apollo/client';
import gql from 'graphql-tag';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import styled from 'styled-components';
import ErrorMessage from '../../components/ErrorMessage';
import OrderStyles from '../../components/styles/OrderStyles';
import formatMoney from '../../lib/formatMoney';
import {
  STATUS_FLOW,
  formatOrderDate,
  isOrderStatus,
  statusLabel
} from '../../lib/orderStatus';

/**
 * Day 26 — one order, with its place in the lifecycle.
 *
 * The query is read-only by construction: there is no mutation here, so a
 * customer's page has no way to move a status even if they tamper with the
 * request. `Order.read` on the backend scopes the lookup to the session's own
 * orders, so asking for somebody else's id returns nothing rather than their
 * receipt.
 */
export const SINGLE_ORDER_QUERY = gql`
  query SINGLE_ORDER_QUERY($id: ID!) {
    order: Order(where: { id: $id }) {
      id
      charge
      total
      status
      createdAt
      statusChangedAt
      user {
        id
      }
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
`;

const StatusPanel = styled.section`
  margin-bottom: 3rem;
  padding: 2rem;
  background: white;
  border-radius: 8px;
  box-shadow: var(--bs);
  h3 {
    margin-top: 0;
    margin-bottom: 1.5rem;
  }
`;

const Timeline = styled.ol`
  display: flex;
  list-style: none;
  padding: 0;
  margin: 0;
  gap: 0.5rem;
  flex-wrap: wrap;
  li {
    flex: 1 1 120px;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    background: var(--lightGray);
    color: var(--gray);
    font-size: 0.9rem;
    text-align: center;
    &.done {
      background: var(--red);
      color: white;
      font-weight: bold;
    }
    &.current {
      outline: 2px solid var(--black);
      outline-offset: 2px;
      font-weight: bold;
    }
  }
`;

const CancelledNote = styled.p`
  margin: 1.5rem 0 0;
  padding: 1rem 1.25rem;
  border-left: 4px solid #8b1a1a;
  background: rgba(139, 26, 26, 0.06);
`;

const NotFound = styled.div`
  max-width: 600px;
  margin: 4rem auto;
  text-align: center;
  p {
    margin-bottom: 2rem;
  }
  a {
    color: var(--red);
    font-weight: bold;
  }
`;

export default function SingleOrderPage() {
  const router = useRouter();
  const { id } = router.query;
  const { data, error, loading } = useQuery(SINGLE_ORDER_QUERY, {
    variables: { id },
    skip: !id
  });

  if (loading) return <p>Loading...</p>;
  if (error) return <ErrorMessage error={error} />;

  const order = data && data.order;

  if (!order) {
    return (
      <NotFound data-testid="order-not-found">
        <Head>
          <title>Order not found | TrendyFits</title>
        </Head>
        <h2>We could not find that order</h2>
        <p>It may belong to another account, or the link may be wrong.</p>
        <Link href="/order">Back to your orders</Link>
      </NotFound>
    );
  }

  const status = isOrderStatus(order.status) ? order.status : 'CREATED';
  const currentIndex = STATUS_FLOW.indexOf(status);
  const items = order.items || [];

  return (
    <OrderStyles data-testid="single-order">
      <Head>
        <title>TrendyFits - Order {order.id}</title>
      </Head>

      <StatusPanel>
        <h3>
          Status: <span data-testid="order-status">{statusLabel(order.status)}</span>
        </h3>
        {status === 'CANCELLED' ? (
          <CancelledNote data-testid="order-cancelled">
            This order was cancelled. If you were charged, the refund is handled
            separately — contact us with the order id below if it has not reached
            you.
          </CancelledNote>
        ) : (
          <Timeline data-testid="order-timeline">
            {STATUS_FLOW.map((step, index) => (
              <li
                key={step}
                className={
                  index < currentIndex
                    ? 'done'
                    : index === currentIndex
                    ? 'done current'
                    : undefined
                }
              >
                {statusLabel(step)}
              </li>
            ))}
          </Timeline>
        )}
      </StatusPanel>

      <p>
        <span>Order Id:</span>
        <span>{order.id}</span>
      </p>
      <p>
        <span>Placed:</span>
        <span>{formatOrderDate(order.createdAt)}</span>
      </p>
      <p>
        <span>Last status change:</span>
        <span>{formatOrderDate(order.statusChangedAt)}</span>
      </p>
      <p>
        <span>Charge:</span>
        <span>{order.charge}</span>
      </p>
      <p>
        <span>Order Total:</span>
        <span>{formatMoney(order.total)}</span>
      </p>
      <p>
        <span>Item Count:</span>
        <span>{items.length}</span>
      </p>
      <div className="items">
        {items.map(item => {
          const photo =
            item.photo && item.photo.image && item.photo.image.publicUrlTransformed;
          return (
            <div className="order-item" key={item.id}>
              {photo ? (
                <img src={photo} alt={item.name} />
              ) : (
                <div className="no-photo">{item.name}</div>
              )}
              <div className="item-details">
                <h2>{item.name}</h2>
                <p>{item.quantity}</p>
                <p>Each: {formatMoney(item.price)}</p>
                <p>Sub Total: {formatMoney(item.price * item.quantity)}</p>
                <p>{item.description}</p>
              </div>
            </div>
          );
        })}
      </div>
      <p>
        <Link href="/order">Back to all orders</Link>
      </p>
    </OrderStyles>
  );
}
