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
      />
    </div>
  );
};

export default SearchableSelect;
