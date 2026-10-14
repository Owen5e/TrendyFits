/**
 * Day 22 — checkout, with every failure path given words.
 *
 * WHAT CHANGED AND WHY (all four paths were probed against the live test key on
 * 2026-10-14; the evidence is in docs/CHECKOUT-AUDIT.md):
 *
 *  1. A 3-D Secure card does not error. `paymentIntents.create({ confirm: true })`
 *     resolves with `status: 'requires_action'` and no error at all, so the old
 *     code — which treated "the call resolved" as "the customer paid" — wrote an
 *     order and returned it. Every card needing authentication was a free order.
 *     `assertChargeSucceeded` now refuses any status but `succeeded`.
 *  2. The charge and the order are two writes with no transaction between them.
 *     The idempotency key plus the lookup-by-charge make a retry land on the
 *     charge it already made instead of making a second one.
 *  3. Stripe's own language is not customer language, and for a wrong key it is
 *     a masked credential. `describeStripeFailure` translates everything.
 *  4. `console.dir(user, { depth: null })` printed the customer's record — name,
 *     email, entire cart — into the server log on every checkout. Removed; the
 *     only thing logged now is a user id and a failure code.
 */
import { KeystoneContext } from "@keystone-next/types";
import { OrderCreateInput } from "../.keystone/schema-types";
import stripeConfig from "../lib/stripe";
import {
  assertChargeSucceeded,
  chargedWithoutOrder,
  checkoutFailure,
  describeStripeFailure,
  idempotencyKey,
  MESSAGES,
} from "../lib/checkoutErrors";

const graphql = String.raw;

interface Arguments {
  token: string;
}

const CART_FIELDS = graphql`
    id
    name
    email
    cart{
        id
        quantity
        product{
            name
            price
            description
            id
            photo{
                id
                image{
                    id
                    publicUrlTransformed
                }
            }
        }
    }
    `;

const ORDER_FIELDS = graphql`
      id
      charge
      total
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
          id
          image {
            id
            publicUrlTransformed
          }
        }
      }
    `;

export default async function checkout(
  root: any,
  { token }: Arguments,
  context: KeystoneContext
): Promise<OrderCreateInput> {
  // 1. make sure the user is signed in
  const userId = context.session.itemId;
  if (!userId) {
    throw checkoutFailure({
      message: MESSAGES.notSignedIn,
      retryable: false,
      code: "not_signed_in",
    });
  }
  if (!token) {
    throw checkoutFailure({
      message: MESSAGES.cardFallback,
      retryable: true,
      code: "missing_payment_method",
    });
  }

  // 2. the user and their cart
  const user = await context.lists.User.findOne({
    where: { id: userId },
    resolveFields: CART_FIELDS,
  });

  const cart: any[] = (user && user.cart) || [];
  // A cart row whose product was deleted cannot be priced, so it cannot be sold.
  const cartItems: any[] = cart.filter((cartItem) => cartItem.product);

  if (cartItems.length === 0) {
    // Without this guard an empty bag reaches Stripe as amount 0, and the
    // customer is shown a paragraph about minimum charge amounts.
    throw checkoutFailure({
      message: MESSAGES.emptyCart,
      retryable: false,
      code: "empty_cart",
    });
  }

  // 3. calculate the total price of the order
  //    (prices are whole cents throughout: formatMoney divides by 100 to display)
  const amount = cartItems.reduce(function (tally: number, cartItem: any) {
    return tally + cartItem.quantity * cartItem.product.price;
  },
  0);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw checkoutFailure({
      message: MESSAGES.belowMinimum,
      retryable: false,
      code: "bad_amount",
    });
  }

  // 4. create the charge with stripe, at most once per bag. Repeating this
  //    exact call — a double-click, an impatient retry — replays the stored
  //    response instead of taking the money twice.
  let charge;
  try {
    charge = await stripeConfig.paymentIntents.create(
      {
        amount,
        currency: "USD",
        confirm: true,
        payment_method: token,
      },
      { idempotencyKey: idempotencyKey(userId, cartItems) }
    );
  } catch (err: any) {
    const failure = describeStripeFailure(err);
    console.error(
      `[checkout] charge failed user=${userId} items=${cartItems.length} code=${failure.code} stripe=${(err && err.type) || "unknown"}`
    );
    throw checkoutFailure(failure);
  }

  // 5. a resolved promise is not a payment. Only `succeeded` is.
  assertChargeSucceeded(charge);

  // 6. if this charge already has an order against it, this is a retry of a
  //    purchase that landed — hand back the order rather than writing a second.
  const alreadyWritten = await context.lists.Order.findMany({
    where: { charge: charge.id },
    take: 1,
    resolveFields: ORDER_FIELDS,
  });
  if (alreadyWritten && alreadyWritten.length) {
    await context.lists.CartItem.deleteMany({
      ids: cart.map((cartItem) => cartItem.id),
    });
    return alreadyWritten[0];
  }

  // 7. convert the CartItems to OrderItems
  const orderItems = cartItems.map((cartItem) => {
    const orderItem = {
      name: cartItem.product.name,
      description: cartItem.product.description,
      price: cartItem.product.price,
      quantity: cartItem.quantity,
      // A product photo is optional, and reading `.id` off a missing one threw
      // a TypeError after the customer had already been charged.
      photo: cartItem.product.photo
        ? { connect: { id: cartItem.product.photo.id } }
        : undefined,
    };
    return orderItem;
  });

  // 8. create the order and return it
  let order;
  try {
    order = await context.lists.Order.createOne({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: { connect: { id: userId } },
      },
      resolveFields: ORDER_FIELDS,
    });
  } catch (err: any) {
    // The customer's money has moved but the order did not get written. This is
    // the one failure that must never be silent, so it names the charge.
    console.error(
      `[checkout] charged but order write failed user=${userId} charge=${charge.id} error=${err && err.message}`
    );
    throw checkoutFailure(chargedWithoutOrder(charge.id));
  }

  // 9. clean up the cart items
  const cartItemIds = cart.map((cartItem) => cartItem.id);
  await context.lists.CartItem.deleteMany({
    ids: cartItemIds,
  });

  return order;
}
