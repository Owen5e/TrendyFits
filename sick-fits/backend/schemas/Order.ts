import {
  integer,
  relationship,
  select,
  text,
  timestamp,
  virtual,
} from "@keystone-next/fields";
import { list } from "@keystone-next/keystone/schema";
import formatMoney from "../lib/formatMoney";
import { READ_ONLY } from "../lib/fieldAccess";
import {
  ORDER_STATUSES,
  STATUS_LABELS,
  resolveStatusInput,
} from "../lib/orderStatus";
import { isSignedIn, permissions, rules } from "../access";

export const Order = list({
  access: {
    create: isSignedIn,
    read: rules.canReadOrders,
    // F5: order history stays immutable for customers, but an administrator holding
    // `canManageOrders` can correct a mis-charged order through the API instead of
    // going into the database. Deleting financial history remains impossible —
    // corrections are updates, and the record is retained.
    update: permissions.canManageOrders,
    delete: () => false,
  },
  hooks: {
    // Day 26: the status may only move along a legal edge (see
    // lib/orderStatus.ts). Enforced here, at the one place every write passes
    // through — the admin UI and the GraphQL API both go through resolveInput.
    resolveInput: ({
      operation,
      existingItem,
      resolvedData,
      context,
    }: any) => {
      if (!resolvedData) {
        return resolvedData;
      }
      // A write that does not touch the status is not a status change; leave it
      // alone so an unrelated correction never restamps the timestamp.
      if (
        operation === "update" &&
        (resolvedData.status === undefined || resolvedData.status === null)
      ) {
        return resolvedData;
      }
      return resolveStatusInput({
        operation,
        existingItem,
        resolvedData,
        session: context?.session,
      });
    },
  },
  // No `ui:` block on purpose. This Keystone version (9.3.1, pinned) accepts
  // `ui.labelField` / `ui.listView` / `ui.createView` in its TYPES but the
  // runtime drops them: @keystone-next/keystone's initConfig passes only
  // fields/access/hooks to createList, with a FIXME listing labelField and
  // adminConfig as unsupported. Shipping config that is silently ignored is a
  // lie to the next reader, so the admin list keeps the shipped default columns
  // and the finding is recorded in docs/ORDER-STATUS.md instead.
  // `npm run check:schema` prints what the admin meta actually contains.
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
    // Day 26 — the lifecycle. Only staff may set or move it (field-level access),
    // and only along a legal edge (the hook above). A customer's checkout does
    // not pass this field at all, so the default applies.
    status: select({
      options: ORDER_STATUSES.map((value) => ({
        label: STATUS_LABELS[value],
        value,
      })),
      defaultValue: "CREATED",
      isRequired: true,
      isIndexed: true,
      // The same version limitation applies here: `ui.displayMode` never reaches
      // the admin UI (the field's `views` map is empty and its adapter is
      // MongoTextInterface), so a staff member edits this as a text value. The
      // lifecycle is therefore enforced where it cannot be bypassed — in the
      // hook below, which refuses an invented status or an illegal edge with a
      // sentence naming the legal alternatives.
      access: {
        create: permissions.canManageOrders,
        update: permissions.canManageOrders,
      },
    }),
    createdAt: timestamp({
      // A function, not a captured string: a module-level `Date.now()` would
      // freeze at boot and date every order to the moment the server started.
      defaultValue: () => new Date().toISOString(),
      // A date is a fact about the past. Neither customers nor staff may edit it.
      access: READ_ONLY,
    }),
    statusChangedAt: timestamp({
      defaultValue: () => new Date().toISOString(),
      // Stamped by the hook when the status actually moves, never by a caller.
      access: READ_ONLY,
    }),
  },
});
