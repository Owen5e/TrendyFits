import { graphQLSchemaExtension } from '@keystone-next/keystone/schema';
import addToCart from './addToCart';
import checkout from './checkout';
import mergeCart from './mergeCart';
import removeFromCart from './removeFromCart';

// make a fake graphql tagged template literal
const graphql = String.raw;

export const extendGraphqlSchema = graphQLSchemaExtension({
  typeDefs: graphql`
    type Mutation {
      addToCart(productId: ID!): CartItem
      checkout(token: String!): Order
      removeFromCart(id: ID!): CartItem
      # Day 21: fold a browser-held cart into the signed-in cart. Per product the
      # LARGER quantity wins, never the sum — see lib/cartRules.ts#mergeQuantity.
      mergeCart(items: [CartLineInput!]!): [CartItem]
    }

    input CartLineInput {
      productId: ID!
      quantity: Int!
    }
  `,
  resolvers: {
    Mutation: {
      addToCart,
      checkout,
      mergeCart,
      removeFromCart,
    },
  },
});
