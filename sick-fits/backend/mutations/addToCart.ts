/* eslint-disable */
import { KeystoneContext } from '@keystone-next/types';
import { lineLimit } from '../lib/cartRules';

export default async function addToCart(
  root: any,
  { productId }: { productId: string },
  context: KeystoneContext,
): Promise<any> {
  console.log('Adding to cart!!');

  // 1. Get the current user ID
  const sesh = context.session as any;
  if (!sesh?.itemId) {
    throw new Error('You must be logged in to do this!');
  }
  const currentUserId = sesh.itemId;

  console.log('Current user ID:', currentUserId);

  // 1b. Day 20, "max stock": a per-line ceiling has to be enforced where the write
  // happens, not only on the screen. The product is read first so the cap is the
  // real one (its stock, or the default line limit when stock is not recorded).
  // Read through the list API, so `rules.canReadProducts` applies: a Draft or
  // Unavailable product is not findable here and cannot be added to a cart.
  // No `query` argument: keystone-next 9's generated types for `.findOne` only
  // accept `where`, and the default selection returns the whole item — including
  // the `stock` this rule needs. (Day 19's log has the same lesson: a cast or a
  // widened signature to satisfy tsc would have added a 24th pre-existing error.)
  const product = await context.lists.Product.findOne({ where: { id: productId } });
  if (!product) {
    throw new Error('That product is not available.');
  }
  const limit = lineLimit(product);

  // 2 query the current user's cart
  // Use context.lists.CartItem.findMany() - the access control (rules.canOrder)
  // automatically filters to only the current user's cart items
  let allCartItems;
  try {
    console.log('Fetching cart items for user:', currentUserId);
    // Get all cart items for the current user (access control handles the user filter)
    allCartItems = await context.lists.CartItem.findMany({});
    console.log('All cart items for user:', allCartItems);

    // Filter by product ID in JavaScript since relationship filters
    // don't work reliably in context.lists
    const filteredItems = [];
    for (const item of allCartItems) {
      // Use GraphQL to get the full item with product relationship
      const fullItemResult = await context.graphql.run({
        query: `
          query GetCartItem($id: ID!) {
            CartItem(where: { id: $id }) {
              id
              quantity
              product {
                id
              }
            }
          }
        `,
        variables: { id: item.id },
      });
      const fullItem = fullItemResult.CartItem;
      // Check if product matches - product could be an object with id or just an id string
      const itemProductId = fullItem?.product?.id || fullItem?.product || null;
      if (itemProductId && String(itemProductId) === String(productId)) {
        filteredItems.push(fullItem);
      }
    }
    allCartItems = filteredItems;
    console.log('Filtered cart items for product (JS):', allCartItems);
  } catch (error: any) {
    console.error('Error finding cart items:', error);
    console.log('Current user ID:', currentUserId);
    console.log('Product ID:', productId);
    throw new Error('Failed to find cart items. Please try again.');
  }

  const [existingCartItem] = allCartItems;
  if (existingCartItem) {
    console.log('Existing cart item:', existingCartItem);

    // Use GraphQL directly to get the current quantity
    // This ensures we get the quantity field
    const graphqlResult = await context.graphql.run({
      query: `
        query GetCartItem($id: ID!) {
          CartItem(where: { id: $id }) {
            id
            quantity
          }
        }
      `,
      variables: { id: existingCartItem.id },
    });

    const cartItemWithQuantity = graphqlResult.CartItem;
    console.log('Cart item with quantity from GraphQL:', cartItemWithQuantity);

    const currentQuantity = cartItemWithQuantity?.quantity || 1;
    console.log('Current quantity:', currentQuantity);

    // 3 see if the item is already in their cart
    // 4 if it is, increment by 1 — unless that would break the line ceiling.
    const newQuantity = currentQuantity + 1;
    if (newQuantity > limit) {
      // Refuse in words the customer can act on, and never write the over-limit
      // number: the day-20 rule is that the screen is advisory and this is the cap.
      throw new Error(
        `Only ${limit} of ${product.name} per order — your bag already has ${currentQuantity}.`,
      );
    }
    console.log('Updating cart item with new quantity:', newQuantity);

    // Use GraphQL directly to update with the new quantity
    const updateResult = await context.graphql.run({
      query: `
        mutation UpdateCartItem($id: ID!, $quantity: Int!) {
          updateCartItem(id: $id, data: { quantity: $quantity }) {
            id
            quantity
          }
        }
      `,
      variables: { id: existingCartItem.id, quantity: newQuantity },
    });

    console.log('Update result:', updateResult);
    return updateResult.updateCartItem;
  }
  // 5 if it is not, create a new cart item for that user
  console.log('Creating new cart item...');
  try {
    // Use GraphQL to create the cart item
    const createResult = await context.graphql.run({
      query: `
        mutation CreateCartItem($productId: ID!, $userId: ID!) {
          createCartItem(data: { product: { connect: { id: $productId } }, user: { connect: { id: $userId } } }) {
            id
            quantity
            product {
              id
            }
          }
        }
      `,
      variables: {
        productId: productId,
        userId: currentUserId,
      },
    });
    console.log('Create result:', createResult);
    return createResult.createCartItem;
  } catch (createError: any) {
    console.error('Error creating cart item via GraphQL:', createError);
    // Fallback to context.lists
    console.log('Falling back to context.lists for create...');
    return await context.lists.CartItem.createOne({
      data: {
        product: { connect: { id: productId } },
        user: { connect: { id: currentUserId } },
      },
    });
  }
}
