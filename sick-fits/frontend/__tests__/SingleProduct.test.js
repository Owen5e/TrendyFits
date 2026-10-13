/* eslint-disable */
import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import SingleProduct, { SINGLE_PRODUCT_QUERY } from '../components/SingleProduct';
import { CartStateProvider } from '../lib/cartState';
import { fakeItem, snapshotHTML } from '../lib/testUtils';

const product = fakeItem();
const mocks = [
  {
    // when someone requests this query with these variables
    request: {
      query: SINGLE_PRODUCT_QUERY,
      variables: {
        id: '123'
      }
    },
    // return this data
    result: {
      data: {
        Product: product
      }
    }
  }
];

describe('<SingleProduct/>', () => {
  it('renders with proper data', async () => {
    // we need to make some fake data
    const { container, debug } = render(
      <MockedProvider mocks={mocks}>
        <CartStateProvider><SingleProduct id="123" /></CartStateProvider>
      </MockedProvider>
    );
    // wait for test id to show up
    await screen.findByTestId('singleProduct');
    expect(snapshotHTML(container)).toMatchSnapshot();
  });

  it('errors out when an item is not found', async () => {
    const errorMocks = [
      {
        request: {
          query: SINGLE_PRODUCT_QUERY,
          variables: {
            id: '123'
          }
        },
        result: {
          errors: [{ message: 'Item not found!!!' }]
        }
      }
    ];
    const { container, debug } = render(
      <MockedProvider mocks={errorMocks}>
        <CartStateProvider><SingleProduct id="123" /></CartStateProvider>
      </MockedProvider>
    );
    await screen.findByTestId('graphql-error');
    expect(container).toHaveTextContent('Shoot!');
    expect(container).toHaveTextContent('Item not found!!!');
  });
});
