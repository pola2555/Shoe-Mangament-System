import { useState } from 'react';
import '../products/Products.css';
import { useTranslation } from '../../i18n/i18nContext';

import CustomerReturns from './CustomerReturns';
import SupplierReturns from './SupplierReturns';

/**
 * Returns page
 * Handles tab navigation between CustomerReturns and SupplierReturns
 */
export default function ReturnsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('customer');

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('returns.title')}</h1>
      </div>

      <div className="tabs" style={{ marginBottom: 'var(--spacing-lg)' }}>
        <button className={`tab ${tab === 'customer' ? 'tab--active' : ''}`} onClick={() => setTab('customer')}>
          {t('returns.customer_returns')}
        </button>
        <button className={`tab ${tab === 'supplier' ? 'tab--active' : ''}`} onClick={() => setTab('supplier')}>
          {t('returns.supplier_returns')}
        </button>
      </div>

      {tab === 'customer' && <CustomerReturns />}
      {tab === 'supplier' && <SupplierReturns />}
    </div>
  );
}
