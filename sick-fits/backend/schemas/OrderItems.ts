import { integer, relationship, select, text } from "@keystone-next/fields";
import { list } from "@keystone-next/keystone/schema";
import { isSignedIn, permissions, rules } from "../access";

export const OrderItem = list({
  access: {
    create: isSignedIn,
    read: rules.canManageOrderItems,
    // F5: same policy as Order — `canManageOrders` may correct a line item,
    // nobody may delete one.
    update: permissions.canManageOrders,
    delete: () => false,
  },
  fields: {
    name: text({ isRequired: true }),
    description: text({
      ui: {
        displayMode: "textarea",
      },
    }),
    photo: relationship({
      ref: "ProductImage",
      ui: {
        displayMode: "cards",
        cardFields: ["image", "altText"],
        inlineCreate: { fields: ["image", "altText"] },
        inlineEdit: { fields: ["image", "altText"] },
      },
    }),

    price: integer(),
    quantity: integer(),
    order: relationship({ ref: "Order.items" }),

    // ToDo Photo
  },
});
