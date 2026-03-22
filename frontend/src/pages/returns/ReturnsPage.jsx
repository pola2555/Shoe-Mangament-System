import { useState } from 'react';
import '../products/Products.css';

import CustomerReturns from './CustomerReturns';
import SupplierReturns from './SupplierReturns';

/**
 * Returns page
 * Handles tab navigation between CustomerReturns and SupplierReturns
 */
export default function ReturnsPage() {
  const [tab, setTab] = useState('customer');

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Returns</h1>
      </div>

      <div className="tabs" style={{ marginBottom: 'var(--spacing-lg)' }}>
        <button className={`tab ${tab === 'customer' ? 'tab--active' : ''}`} onClick={() => setTab('customer')}>
          Customer Returns
        </button>
        <button className={`tab ${tab === 'supplier' ? 'tab--active' : ''}`} onClick={() => setTab('supplier')}>
          Supplier Returns
        </button>
      </div>

      {tab === 'customer' && <CustomerReturns />}
      {tab === 'supplier' && <SupplierReturns />}
    </div>
  );
}
