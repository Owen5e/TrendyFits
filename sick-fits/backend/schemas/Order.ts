import {
  integer,
  relationship,
  select,
  text,
  virtual,
} from "@keystone-next/fields";
import { list } from "@keystone-next/keystone/schema";
import formatMoney from "../lib/formatMoney";
import { isSignedIn, permissions, rules } from "../access";

export const Order = list({
  access: {
    create: isSignedIn,
    read: rules.canOrder,
    // F5: order history stays immutable for customers, but an administrator holding
    // `canManageOrders` can correct a mis-charged order through the API instead of
    // going into the database. Deleting financial history remains impossible —
    // corrections are updates, and the record is retained.
    update: permissions.canManageOrders,
    delete: () => false,
  },
  fields: {
    label: virtual({
      graphQLReturnType: "String",
      resolver(item) {
        return ` ${formatMoney(item.total)}`;
      },
    }),
    total: integer(),
    items: relationship({ ref: "OrderItem.order", many: true }),
    user: relationship({ ref: "User.orders" }),
    charge: text(),
  },
});
