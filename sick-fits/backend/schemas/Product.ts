import { integer, relationship, select, text } from '@keystone-next/fields';
import { list } from '@keystone-next/keystone/schema';
import { isSignedIn, rules } from '../access';

export const Product = list({
  access: {
    create: isSignedIn,
    read: rules.canReadProducts,
    update: rules.canManageProducts,
    delete: rules.canManageProducts,
  },
  fields: {
    name: text({ isRequired: true }),
    description: text({
      ui: {
        displayMode: 'textarea',
      },
    }),
    photo: relationship({
      ref: 'ProductImage.product',
      ui: {
        displayMode: 'cards',
        cardFields: ['image', 'altText'],
        inlineCreate: { fields: ['image', 'altText'] },
        inlineEdit: { fields: ['image', 'altText'] },
      },
    }),
    status: select({
      options: [
        { label: 'Draft', value: 'Draft' },
        { label: 'Available', value: 'Available' },
        { label: 'Unavailable', value: 'Unavailable' },
      ],
      defaultValue: 'Draft',
      ui: {
        displayMode: 'segmented-control',
        createView: { fieldMode: 'hidden' },
      },
    }),
    price: integer(),
    // Day 20, "max stock": a per-line ceiling needs a real number to cap against.
    // Before this field the only possible limit was a hard-coded constant, which
    // is what `lib/cartRules.ts#lineLimit` falls back to when this is null. Keystone
    // adds the column on the next `npm run dev`; existing rows read as null, and
    // null means "use the default line limit" rather than "sold out".
    stock: integer({
      defaultValue: 100,
      ui: {
        description:
          'Units available. Caps how many may sit in one cart line (1–stock). Leave empty to fall back to the default line limit.',
      },
    }),
    user: relationship({
      ref: 'User.products',
      defaultValue: ({ context }) => ({
        connect: { id: context.session.itemId },
      }),
    }),
    categories: relationship({
      ref: 'Category.products',
      many: true,
      ui: {
        displayMode: 'select',
        labelField: 'name',
      },
    }),
    // ToDo Photo
  },
});
