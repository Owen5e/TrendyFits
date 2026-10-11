import { cloudinaryImage } from "@keystone-next/cloudinary";
import { relationship, text } from "@keystone-next/fields";
import { list } from "@keystone-next/keystone/schema";
import "dotenv/config";
import { isSignedIn, rules } from "../access";

const cloudinary = {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_KEY,
  apiSecret: process.env.CLOUDINARY_SECRET,
  folder: "sickfits",
};

export const ProductImage = list({
  access: {
    create: isSignedIn,
    // F1: never world-readable — an image follows its product's status.
    read: rules.canReadProductImages,
    // F2: permission-or-ownership, matching the Product list.
    update: rules.canManageProductImages,
    delete: rules.canManageProductImages,
  },
  fields: {
    image: cloudinaryImage({
      cloudinary,
      label: "Source",
    }),
    altText: text(),
    product: relationship({ ref: "Product.photo" }),
  },
  ui: {
    listView: {
      initialColumns: ["image", "altText", "product"],
    },
  },
});
