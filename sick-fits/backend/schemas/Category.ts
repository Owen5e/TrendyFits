import { relationship, text } from '@keystone-next/fields';
import { list } from '@keystone-next/keystone/schema';
import slugify from '@sindresorhus/slugify';
import { isSignedIn, rules } from '../access';

export const Category = list({
  access: {
    create: isSignedIn,
    read: true, // Everyone can read categories
    // F3: Category has no `user` field, so `rules.canManageProducts` filtered on a
    // column that does not exist. Use the rule Category can actually satisfy.
    update: rules.canManageCategories,
    delete: rules.canManageCategories,
  },
  hooks: {
    resolveInput: ({ resolvedData, operation }) => {
      // Only auto-generate slug on create
      if (operation === 'create') {
        const { name } = resolvedData;
        if (name) {
          return {
            ...resolvedData,
            slug: slugify(name),
          };
        }
      }
      return resolvedData;
    },
  },
  fields: {
    name: text({ isRequired: true }),
    description: text({
      ui: {
        displayMode: 'textarea',
      },
    }),
    slug: text({
      isRequired: true,
      isUnique: true,
      ui: {
        createView: { fieldMode: 'hidden' },
      },
    }),
    products: relationship({
      ref: 'Product.categories',
      many: true,
    }),
    // Optional: Add image for category banners
    image: relationship({
      ref: 'ProductImage',
      ui: {
        displayMode: 'cards',
        cardFields: ['image', 'altText'],
        inlineCreate: { fields: ['image', 'altText'] },
        inlineEdit: { fields: ['image', 'altText'] },
      },
    }),
  },
  ui: {
    listView: {
      initialColumns: ['name', 'slug', 'products'],
    },
  },
});
