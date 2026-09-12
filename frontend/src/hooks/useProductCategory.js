import { useState, useEffect } from 'react';
import { productsAPI } from '../api';

/**
 * What a product's category allows: its colours, its size list, and whether it has
 * either at all.
 *
 * Anywhere a product's variants are entered has to know this, or it falls back to the
 * assumption the whole catalogue used to make — that everything is a shoe with EU sizes
 * and a US/UK/CM conversion. The purchase box editor and the box template editor both
 * still made it, so a shop receiving socks was asked for shoe sizes.
 *
 * `productsAPI.getById` already returns the colours AND `category.size_values` in one
 * response, so this replaces the `listColors` call rather than adding to it.
 *
 * A product with no category predates the categories feature. It is treated as the app
 * used to treat everything — colours and free-text sizes — rather than as an error.
 */
export default function useProductCategory(productId) {
  const [state, setState] = useState({
    loading: false,
    colors: [],
    category: null,
    sizeValues: [],
    hasColors: true,
    hasSizes: true,
    isNumeric: true,
    prefix: '',
    suffix: '',
    legacy: true,
  });

  useEffect(() => {
    let cancelled = false;

    if (!productId) {
      setState((s) => ({ ...s, loading: false, colors: [], category: null, sizeValues: [] }));
      return undefined;
    }

    setState((s) => ({ ...s, loading: true }));
    productsAPI.getById(productId)
      .then(({ data }) => {
        if (cancelled) return;
        const product = data.data;
        const category = product.category || null;
        setState({
          loading: false,
          colors: product.colors || [],
          category,
          sizeValues: category?.size_values || [],
          // No category: behave as before — both required, free text.
          hasColors: category ? category.has_colors !== false : true,
          hasSizes: category ? category.has_sizes !== false : true,
          isNumeric: category ? category.scale_is_numeric !== false : true,
          prefix: category?.display_prefix || '',
          suffix: category?.display_suffix || '',
          legacy: !category,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false }));
      });

    return () => { cancelled = true; };
  }, [productId]);

  return state;
}
