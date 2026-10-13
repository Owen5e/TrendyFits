import Link from 'next/link';
import { useRouter } from 'next/router';
import { Space_Mono } from 'next/font/google';
import { useEffect, useRef, useState } from 'react';
import { mergeForDisplay } from '../lib/anonCart';
import { cartSummary } from '../lib/cartLines';
import { useCart } from '../lib/cartState';
import CartCount from './CartCount';
import { useUser } from './User';

const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap'
});

export default function Nav({ onToggleSearch, isSearchOpen = false }) {
  const { pathname } = useRouter();
  const user = useUser();
  console.log('Nav - Current user:', user);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const { openCart, localCart = [] } = useCart();

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsMenuOpen(false);
      }
    };

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isMenuOpen]);

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  const isActive = path => pathname.startsWith(path);

  const linkClass = path =>
    `text-[#4a463c] hover:text-black hover:border-[#ff4a17] transition-colors font-medium block py-2 px-4 md:py-0 md:px-0 border-b-2 ${
      isActive(path) ? 'border-[#ff4a17] text-black' : 'border-transparent'
    }`;

  // Day 21: the badge counts the cart the customer is actually carrying — the
  // server cart when signed in, the browser cart when signed out, and the
  // larger-quantity union of the two while a merge is still in flight. Counting
  // both sides separately would double-count a line that is in both.
  const bagLines = mergeForDisplay(user?.cart || [], localCart);
  const { count: bagCount } = cartSummary(bagLines);

  const SearchIcon = () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M20 20L16.65 16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );

  const AccountIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
      <path d="M4 20c0-4 3.6-8 8-8s8 4 8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );

  const PrimaryLinks = () => (
    <div className="flex items-center gap-6">
      <Link
        href="/products"
        className={`text-[#4a463c] hover:text-black transition-colors font-normal block py-2 px-4 md:py-0 md:px-0 border-b-2 ${
          isActive('/products') ? 'border-[#ff4a17] text-black' : 'border-transparent'
        }`}
      >
        SHOP ALL
      </Link>
      {user && (
        <Link href="/order" className={linkClass('/order')}>
          Orders
        </Link>
      )}
      {user && (
        <Link href="/sell" className={linkClass('/sell')}>
          Sell
        </Link>
      )}
    </div>
  );

  const DesktopNavLinks = () => (
    <div className={`${spaceMono.className} hidden md:grid w-full grid-cols-2 items-center`}>
      <div className="flex items-center gap-6 justify-self-center">
        <PrimaryLinks />
      </div>

      <div className="flex items-center gap-6 justify-self-end">
        <button
          type="button"
          onClick={onToggleSearch}
          className="text-[#4a463c] hover:text-black transition-colors font-medium flex items-center"
          aria-label="Toggle search"
          aria-expanded={isSearchOpen}
          aria-controls="header-search"
        >
          <SearchIcon />
        </button>
        <Link
          href={user ? '/account' : '/signin'}
          className={`text-[#4a463c] hover:text-black transition-colors font-medium flex items-center border-b-2 ${
            isActive('/account') || isActive('/signin') ? 'border-[#ff4a17] text-black' : 'border-transparent'
          }`}
          aria-label={user ? 'Account' : 'Sign In'}
        >
          <AccountIcon />
        </Link>

        <button
          type="button"
          onClick={openCart}
          aria-label="Open bag"
          className="text-[#4a463c] hover:text-black transition-colors font-medium flex items-center md:py-0 md:px-0"
        >
          <span className="ml-1 pb-0.5">🛒 </span>
          <span>Bag </span>
          <CartCount count={bagCount} />
        </button>
      </div>
    </div>
  );

  const MobileNavLinks = () => (
    <div className={`${spaceMono.className} flex flex-col gap-2`}>
      <button type="button" onClick={onToggleSearch} className={`${linkClass('/')} text-left`}>
        Search
      </button>
      <PrimaryLinks />
      {user && (
        <Link href="/account" className={linkClass('/account')}>
          Account
        </Link>
      )}
      <button
        type="button"
        onClick={openCart}
        aria-label="Open bag"
        className="text-[#4a463c] hover:text-black transition-colors font-medium flex items-center py-2 px-4"
      >
        <span className="ml-1 pb-0.5">🛒 </span>
        <span>Bag </span>
        <CartCount count={bagCount} />
      </button>
    </div>
  );

  return (
    <div ref={menuRef}>
      {/* Hamburger menu button for mobile */}
      <button
        type="button"
        className="md:hidden text-white focus:outline-none focus:ring-2 focus:ring-primary-light rounded-md p-2"
        onClick={toggleMenu}
        aria-label="Toggle navigation menu"
      >
        <div className="w-6 h-6 flex flex-col justify-center items-center">
          <span
            className={`block h-0.5 w-6 bg-white transform transition-transform duration-300 ${
              isMenuOpen ? 'rotate-45 translate-y-1.5' : ''
            }`}
          />
          <span
            className={`block h-0.5 w-6 bg-white my-1 transition-opacity duration-300 ${
              isMenuOpen ? 'opacity-0' : 'opacity-100'
            }`}
          />
          <span
            className={`block h-0.5 w-6 bg-white transform transition-transform duration-300 ${
              isMenuOpen ? '-rotate-45 -translate-y-1.5' : ''
            }`}
          />
        </div>
      </button>

      {/* Desktop navigation */}
      <nav className="w-full">
        <DesktopNavLinks />
      </nav>

      {/* Mobile navigation menu */}
      <div
        className={`md:hidden absolute top-full left-0 right-0 bg-secondary-dark shadow-lg z-50 transition-all duration-300 ease-in-out ${
          isMenuOpen
            ? 'opacity-100 transform translate-y-0'
            : 'opacity-0 transform -translate-y-4 pointer-events-none'
        }`}
      >
        <div className="flex flex-col py-4 px-4">
          <MobileNavLinks />
        </div>
      </div>
    </div>
  );
}
