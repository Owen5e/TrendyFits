import { useQuery } from '@apollo/client';
import gql from 'graphql-tag';

export const CURRENT_USER_QUERY = gql`
  query {
    authenticatedItem {
      ... on User {
        id
        email
        name
        # query the cart items for the current user
        cart {
          id
          quantity
          product {
            id
            price
            name
            # Day 20: the per-line ceiling is the product's own stock, so the cart
            # screen can disable its + button before the server has to refuse.
            stock
            description
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

export function useUser() {
  const { data, error, loading, refetch } = useQuery(CURRENT_USER_QUERY, {
    fetchPolicy: 'network-only',
    pollInterval: 5000
  });

  if (error) {
    console.error('Error fetching user:', error);
  }

  if (loading) {
    console.log('Loading user data...');
  }

  return data?.authenticatedItem;
}
