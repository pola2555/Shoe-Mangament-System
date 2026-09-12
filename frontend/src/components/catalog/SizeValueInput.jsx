import { useId } from 'react';
import { sizeValueLabel } from '../../utils/variantFormat';
import { useTranslation } from '../../i18n/i18nContext';

/**
 * One size cell, offering the category's own values without forbidding anything else.
 *
 * A `<datalist>` rather than a `<select>`, deliberately. Receiving stock is the one
 * place the system accepts a size that is not on the category's list — see
 * `resolveVariantTarget`'s `allowOffScale`: refusing a delivery at the loading bay over
 * a mis-typed size is worse than accepting it and sorting it out later. A select would
 * make that impossible; a datalist makes the right answer one keystroke away and the
 * wrong one still possible.
 *
 * With no size values (a product with no category, or a free-text template) it is a
 * plain text box, exactly as before.
 */
export default function SizeValueInput({ value, onChange, sizeValues = [], locale, ...rest }) {
  const listId = useId();
  const { t } = useTranslation();
  const hasList = sizeValues.length > 0;

  return (
    <>
      <input
        className="form-input"
        value={value ?? ''}
        list={hasList ? listId : undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hasList ? sizeValueLabel(sizeValues[0], locale) : t('products.size_generic')}
        {...rest}
      />
      {hasList && (
        <datalist id={listId}>
          {sizeValues.map((v) => (
            <option key={v.id || v.value} value={v.value}>{sizeValueLabel(v, locale)}</option>
          ))}
        </datalist>
      )}
    </>
  );
}
