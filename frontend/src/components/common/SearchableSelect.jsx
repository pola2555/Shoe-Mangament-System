import React from 'react';
import Select from 'react-select';

/**
 * SearchableSelect
 * A wrapper around react-select styled to match the dark glassmorphism theme.
 * Takes the same props as a native select (value as string, onChange expects an event-like object)
 * but provides full typing/search capabilities.
 */
const SearchableSelect = ({
  options, // expects [{ value, label }]
  value,
  onChange,
  placeholder = 'Select...',
  required = false,
  className = '',
  style = {},
  isClearable = true,
}) => {
  // Find the full option object that matches the current raw string value
  const selectedOption = options.find(opt => opt.value === value) || null;

  // Simulate a native event target so existing onChange handlers don't break
  const handleChange = (selected) => {
    onChange({
      target: {
        value: selected ? selected.value : ''
      }
    });
  };

  const customStyles = {
    control: (base, state) => ({
      ...base,
      backgroundColor: 'var(--color-surface)',
      borderColor: state.isFocused ? 'var(--color-primary)' : 'var(--color-border)',
      boxShadow: state.isFocused ? '0 0 0 1px var(--color-primary)' : 'none',
      '&:hover': {
        borderColor: 'var(--color-primary)'
      },
      borderRadius: 'var(--radius-md)',
      padding: '0.1rem 0',
      minHeight: '40px',
      ...style
    }),
    menu: (base) => ({
      ...base,
      backgroundColor: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-lg)',
      zIndex: 9999,
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    }),
    /**
     * The menu is rendered into document.body (see menuPortalTarget below), so it needs
     * a z-index of its own — the one on `menu` above applies inside the portal, not to
     * the portal itself, whose default is 1.
     *
     * Above the modal overlay (200) and the confirm dialog (300) in styles/index.css,
     * because these selects are used inside both.
     */
    menuPortal: (base) => ({ ...base, zIndex: 400 }),
    option: (base, { isFocused, isSelected }) => ({
      ...base,
      backgroundColor: isSelected 
        ? 'var(--color-primary)' 
        : isFocused 
          ? 'rgba(99, 102, 241, 0.1)' 
          : 'transparent',
      color: isSelected ? '#ffffff' : 'var(--color-text)',
      cursor: 'pointer',
      '&:active': {
        backgroundColor: 'var(--color-primary)'
      }
    }),
    singleValue: (base) => ({
      ...base,
      color: 'var(--color-text)'
    }),
    input: (base) => ({
      ...base,
      color: 'var(--color-text)'
    }),
    placeholder: (base) => ({
      ...base,
      color: 'var(--color-text-muted)'
    }),
    indicatorSeparator: (base) => ({
      ...base,
      backgroundColor: 'var(--color-border)'
    }),
    dropdownIndicator: (base) => ({
      ...base,
      color: 'var(--color-text-muted)',
      '&:hover': {
        color: 'var(--color-text)'
      }
    }),
    clearIndicator: (base) => ({
      ...base,
      color: 'var(--color-text-muted)',
      '&:hover': {
        color: 'var(--color-danger)'
      }
    })
  };

  return (
    <div className={className} style={{ flexGrow: 1 }}>
      <Select
        value={selectedOption}
        onChange={handleChange}
        options={options}
        styles={customStyles}
        placeholder={placeholder}
        isClearable={isClearable}
        classNamePrefix="react-select"
        required={required}
        /*
         * THE MENU ESCAPES ITS CONTAINER.
         *
         * Rendered inline, the list was clipped by whatever scrollable ancestor it
         * happened to sit in, and the purchase-invoice colour picker was the worst
         * case: its row is 600px wide, so the group around it carries
         * `overflow-x: auto` — and CSS does not allow `overflow-x: auto` with
         * `overflow-y: visible`, so the browser quietly promotes the vertical axis to
         * `auto` as well. The colour list was cut off a line or two down, inside a
         * scrollbar most people never noticed was there.
         *
         * A z-index cannot fix that: z-index decides what draws on top, not what gets
         * clipped. Only moving the menu out of the clipping ancestor does, which is
         * what the portal is for. Every table-container and modal in the app has the
         * same overflow, so this is fixed here rather than at the twenty call sites.
         *
         * `fixed` keeps it pinned to the control when an ancestor scrolls, and
         * menuShouldScrollIntoView is off because its attempt to scroll the menu into
         * view is itself a cause of the container lurching when the list opens.
         */
        menuPortalTarget={typeof document !== 'undefined' ? document.body : null}
        menuPosition="fixed"
        menuShouldScrollIntoView={false}
      />
    </div>
  );
};

export default SearchableSelect;
