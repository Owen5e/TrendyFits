import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  addLocalLine,
  changeLocalLineQuantity,
  clearLocalCart,
  readLocalCart,
  removeLocalLine,
  writeLocalCart
} from './anonCart';

const LocalStateContext = createContext();
const LocalStateProvider = LocalStateContext.Provider;

/**
 * The cart's shared state.
 *
 * Two things live here, and they are deliberately different things:
 *
 *  - the drawer's open/closed state (as before);
 *  - the ANONYMOUS cart (day 21): the lines a signed-out visitor is carrying,
 *    persisted to localStorage.
 *
 * The anonymous cart lives in this provider rather than in each component so that
 * the drawer, the bag badge in the nav, the add-to-bag buttons and the sign-in
 * merge all read and write the same array. Reading localStorage in four places
 * would give four copies that disagree the moment one of them writes.
 *
 * Hydration: the first render (which can happen on the server) has no localStorage,
 * so it starts empty and the stored cart is loaded in an effect. That keeps the
 * server and client markup identical — reading storage during render is how you get
 * a hydration mismatch.
 */
function CartStateProvider({ children }) {
  const [cartOpen, setCartOpen] = useState(false);
  const [localCart, setLocalCartState] = useState([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setLocalCartState(readLocalCart());
    setHydrated(true);
  }, []);

  /** Every write goes through here, so memory and storage cannot diverge. */
  const setLocalCart = useCallback(lines => {
    const next = Array.isArray(lines) ? lines : [];
    setLocalCartState(next);
    writeLocalCart(next);
    return next;
  }, []);

  const addLocalItem = useCallback(
    incoming => {
      let result = null;
      setLocalCartState(current => {
        result = addLocalLine(current, incoming);
        writeLocalCart(result);
        return result;
      });
      return result;
    },
    []
  );

  const changeLocalQuantity = useCallback((productId, delta) => {
    setLocalCartState(current => {
      const next = changeLocalLineQuantity(current, productId, delta);
      writeLocalCart(next);
      return next;
    });
  }, []);

  const removeLocalItem = useCallback(productId => {
    setLocalCartState(current => {
      const next = removeLocalLine(current, productId);
      writeLocalCart(next);
      return next;
    });
  }, []);

  const emptyLocalCart = useCallback(() => {
    clearLocalCart();
    setLocalCartState([]);
  }, []);

  function toggleCart() {
    setCartOpen(!cartOpen);
  }

  function closeCart() {
    setCartOpen(false);
  }

  function openCart() {
    setCartOpen(true);
  }

  const value = useMemo(
    () => ({
      cartOpen,
      setCartOpen,
      toggleCart,
      closeCart,
      openCart,
      localCart,
      hydrated,
      setLocalCart,
      addLocalItem,
      changeLocalQuantity,
      removeLocalItem,
      emptyLocalCart
    }),
    [
      cartOpen,
      localCart,
      hydrated,
      setLocalCart,
      addLocalItem,
      changeLocalQuantity,
      removeLocalItem,
      emptyLocalCart
    ]
  );

  return <LocalStateProvider value={value}>{children}</LocalStateProvider>;
}

// make a custom hook for accessing the cart local state
function useCart() {
  const all = useContext(LocalStateContext);
  return all;
}

export { CartStateProvider, useCart };
