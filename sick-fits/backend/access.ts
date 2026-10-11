// AT it's simplest, the access control returns a yes or no value depending on the users session

import { Permission, permissionsList } from './schemas/fields';
import { ListAccessArgs } from './types';

export function isSignedIn({ session }: ListAccessArgs) {
  return !!session;
}

// Create a type for the permissions object
type PermissionsObj = {
  [key in Permission]: ({ session }: ListAccessArgs) => boolean;
};

const generatedPermissions = Object.fromEntries(
  permissionsList.map((permission) => [
    permission,
    function ({ session }: ListAccessArgs) {
      // F6 (docs/ACCESS-AUDIT.md): a session object that exists without a `data`
      // payload used to throw a TypeError here. An access predicate must deny,
      // never throw, so `data` is optional-chained too.
      return !!session?.data?.role?.[permission];
    },
  ]),
) as { [key in Permission]: ({ session }: ListAccessArgs) => boolean };

// Permission checkers - yes or no
// F4: `isAwesome` was declared here and referenced nowhere. It has been deleted
// rather than left as a checkbox the Role screen appears to grant and the code
// never honours.
export const permissions: PermissionsObj = {
  ...generatedPermissions,
};

// Rule based access control
// Rules can return a boolean or a filter which limits which items they can CRUD
export const rules = {
  canManageProducts({ session }: ListAccessArgs) {
    if (!isSignedIn({ session })) {
      return false;
    }
    // 1. Do they have permission to manage products
    if (permissions.canManageProducts({ session })) {
      return true;
    }
    // 2. if not, do they own this product?
    return { user: { id: session.itemId } };
  },
  canOrder({ session }: ListAccessArgs) {
    if (!isSignedIn({ session })) {
      return false;
    }
    // 1. Do they have permission to manage cart
    if (permissions.canManageCart({ session })) {
      return true;
    }
    // 2. Otherwise, they can only manage their own cart items
    return { user: { id: session.itemId } };
  },
  canManageOrderItems({ session }: ListAccessArgs) {
    if (!isSignedIn({ session })) {
      return false;
    }
    // 1. Do they have permission to manage products
    if (permissions.canManageCart({ session })) {
      return true;
    }
    // 2. if not, do they own this product?
    return { order: { user: { id: session.itemId } } };
  },
  canReadProducts({ session }: ListAccessArgs) {
    if (permissions.canManageProducts({ session })) {
      return true; // They can read everything
    }
    // Everyone else (including unauthenticated users) should only see available products
    return { status: 'Available' };
  },
  // F1: an image is only as public as the product it hangs off. `read: true` on the
  // ProductImage list leaked the image and altText of Draft/Unavailable products to
  // anonymous callers, who could enumerate `allProductImages`.
  // The filter walks the RELATED product. It never queries the ProductImage list
  // from inside a ProductImage access function — that is the self-recursion trap.
  canReadProductImages({ session }: ListAccessArgs) {
    if (permissions.canManageProducts({ session })) {
      return true; // admins see every image, published or not
    }
    return { product: { status: 'Available' } };
  },
  // F2: mirror `canManageProducts` (permission OR ownership) by following the
  // relationship to the owning product, so whoever created a product can manage the
  // image attached to it — the same semantics the Product list itself uses.
  // Again: a relationship filter, not a query against this list.
  canManageProductImages({ session }: ListAccessArgs) {
    // `!session` is not redundant: it narrows the type so `session.itemId` below is
    // a string, which is why this rule adds no new tsc error to the file.
    if (!isSignedIn({ session }) || !session) {
      return false;
    }
    if (permissions.canManageProducts({ session })) {
      return true;
    }
    return { product: { user: { id: session.itemId } } };
  },
  canManageUsers({ session }: ListAccessArgs) {
    if (!isSignedIn({ session })) {
      return false;
    }
    // 1. Do they have permission to manage users
    if (permissions.canManageUsers({ session })) {
      return true;
    }
    // 2. otherwise they can only update themselves
    return { id: session.itemId };
  },
  canManageCategories({ session }: ListAccessArgs) {
    if (!isSignedIn({ session })) {
      return false;
    }
    // 1. Do they have permission to manage categories
    if (permissions.canManageCategories({ session })) {
      return true;
    }
    // 2. F3: Category has no `user` column, so borrowing the product rule's
    // ownership branch (`{ user: { id } }`) filtered on a field that does not
    // exist. The honest rule — and the real behaviour — is: permission holders only.
    return false;
  },
};
