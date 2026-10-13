/* eslint-disable */

import Link from 'next/link';
import formatMoney from '../lib/formatMoney';
import AddToCart from './AddToCart';

export default function Product({ product }) {
  return (
    <div className="group bg-[#f4f1ea] hover:bg-white shadow-subtle overflow-hidden hover:shadow-elevated transition-shadow duration-300 border border-neutral-200 flex flex-col h-full">
      {/* Product Image */}
      <div className="relative overflow-hidden flex-shrink-0 hover:bg-white cursor-pointer">
        <img
          src={product?.photo?.image?.publicUrlTransformed}
          alt={product.name}
          className="w-full h-48 object-contain p-2"
        />

        {/* Categories */}
        {product.categories && product.categories.length > 0 && (
          <div className="absolute top-3 left-2 bg-[#f5f1ea] border border-[#dad4c6] font-mono uppercase text-[10px] text-black px-2 py-0.5 rounded-full shadow-sm">
            {product.categories.map(category => (
              <span key={category.id}>{category.name}</span>
            ))}
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 z-10 p-2 opacity-0 translate-y-6 pointer-events-none transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:translate-y-0 group-focus-within:pointer-events-auto">
          <div className="rounded-lg backdrop-blur-sm  shadow-lg ">
            <AddToCart id={product.id} product={product} />
          </div>
        </div>
      </div>

      {/* Product Content */}
      <div className="pt-4 px-4 flex flex-col flex-grow bg-[#f4f1ea] group-hover:bg-white">
        <div className="flex flex-col ">
          <h3 className="text-[16px] font-extrabold text-[#16140f] mb-2">
            <Link
              href={`/product/${product.id}`}
              className="text-secondary-DEFAULT hover:text-primary-DEFAULT transition-colors"
            >
              {product.name}
            </Link>
          </h3>
          {/* Price Tag */}
          <div className="flex flex-wrap text-[13px] font-extrabold gap-1 mb-3">
            {formatMoney(product.price)}
          </div>
        </div>

        <p className="text-[#807A6C] text-[13px] leading-relaxed mb-3 line-clamp-2 flex-grow">
          {product.description}
        </p>
      </div>
    </div>
  );
}
