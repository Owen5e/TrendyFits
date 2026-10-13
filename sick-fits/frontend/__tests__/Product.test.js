/* eslint-disable */

import { render, screen } from '@testing-library/react';
import { MockedProvider } from '@apollo/client/testing';
import Product from '../components/Product';
import { CartStateProvider } from '../lib/cartState';
import { fakeItem, snapshotHTML } from '../lib/testUtils';

const product = fakeItem();

describe('<Product/>', () => {
  it('renders out the price tag and title', () => {
    const { container, debug } = render(
      <MockedProvider>
        <CartStateProvider><Product product={product} /></CartStateProvider>
      </MockedProvider>
    );
    const priceTag = screen.getByText('$50');
    expect(priceTag).toBeInTheDocument();
    const link = container.querySelector('a');
    expect(link).toHaveAttribute('href', '/product/abc123');
    expect(link).toHaveTextContent(product.name);
  });
  it('Renders and matches the snapshot', () => {
    const { container, debug } = render(
      <MockedProvider>
        <CartStateProvider><Product product={product} /></CartStateProvider>
      </MockedProvider>
    );
    expect(snapshotHTML(container)).toMatchSnapshot();
  });
  it('renders the image properly', () => {
    const { container, debug } = render(
      <MockedProvider>
        <CartStateProvider><Product product={product} /></CartStateProvider>
      </MockedProvider>
    );
    // grab the image
    const img = screen.getByAltText(product.name);
    expect(img).toBeInTheDocument();
  });
});
