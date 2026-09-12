import { useTranslation } from '../../i18n/i18nContext';

/**
 * One pager for every long list.
 *
 * Server-side paging, always — the whole point is that the browser holds one page, not
 * the whole table. So this is a dumb control: it renders the current position and calls
 * back with the page the user asked for. It does NOT slice a client array, because the
 * client only ever has the current page.
 *
 * `pagination` is the shape every paginated endpoint returns:
 *   { page, limit, total, totalPages }
 *
 * Renders nothing when there is only one page AND the page-size selector is not wanted —
 * a single short list should carry no chrome. It still shows the "Showing x–y of N"
 * line whenever there is more than a page, because a list that is silently truncated
 * reads as missing data.
 */
export default function Pagination({ pagination, onPage, onLimit, sizes = [25, 50, 100, 200] }) {
  const { t } = useTranslation();
  if (!pagination) return null;

  const { page, limit, total, totalPages } = pagination;
  if (total === 0) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  // A single page with nothing to change is not worth a row of controls.
  if (totalPages <= 1 && !onLimit) return null;

  return (
    <div className="pagination" data-testid="pagination">
      <span className="pagination__count" data-testid="pagination-count">
        {t('common.showing_range', { from, to, total })}
      </span>

      {totalPages > 1 && (
        <div className="pagination__nav">
          <button type="button" className="btn btn-secondary btn-sm"
            data-testid="pagination-prev"
            disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>
            {t('common.previous')}
          </button>
          <span className="pagination__pos" data-testid="pagination-pos">
            {page} / {totalPages}
          </span>
          <button type="button" className="btn btn-secondary btn-sm"
            data-testid="pagination-next"
            disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}

      {onLimit && (
        <select className="form-input pagination__size" value={limit}
          data-testid="pagination-size"
          onChange={(e) => onLimit(Number(e.target.value))}>
          {sizes.map((n) => (
            <option key={n} value={n}>{t('common.per_page', { n })}</option>
          ))}
        </select>
      )}
    </div>
  );
}
