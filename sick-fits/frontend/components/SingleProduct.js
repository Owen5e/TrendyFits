import { useQuery } from '@apollo/client';
import gql from 'graphql-tag';
import Head from 'next/head';
import { useRouter } from 'next/router';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import AddToCart from './AddToCart';
import DisplayError from './ErrorMessage';

const SINGLE_PRODUCT_QUERY = gql`
  query SINGLE_PRODUCT_QUERY($id: ID!) {
    Product(where: { id: $id }) {
      id
      name
      description
      price
      photo {
        altText
        image {
          publicUrlTransformed
        }
      }
    }
  }
`;

const ProductStyles = styled.div`
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  max-width: var(--maxWidth);
  justify-content: center;
  align-items: top;
  gap: 2rem;
  img {
    width: 100%;
    object-fit: contain;
  }
`;

export default function SingleProduct({ id }) {
  const router = useRouter();
  const { data, loading, error } = useQuery(SINGLE_PRODUCT_QUERY, {
    variables: { id }
  });
  if (loading) return <p>Loading...</p>;
  if (error) return <DisplayError error={error} />;
  const { Product } = data;

  return (
    <ProductStyles data-testid="singleProduct">
      <Head>
        <title>Sick Fits | {Product.name}</title>
      </Head>
      <img src={Product.photo.image.publicUrlTransformed} alt={Product.photo.altText} />
      <div className="details">
        <h2>{Product.name}</h2>
        <p>{Product.description}</p>
        <p>${Product.price}</p>
        <AddToCart id={Product.id} product={Product} />
        <button type="button" onClick={() => router.back()}>
          Back
        </button>
      </div>
    </ProductStyles>
  );
}

SingleProduct.propTypes = {
  id: PropTypes.string.isRequired
};

export { SINGLE_PRODUCT_QUERY };
