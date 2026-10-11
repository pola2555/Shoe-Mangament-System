import ColorThumb from './ColorThumb';
import './PhoneGrid.css';

/**
 * Pick one colour at a time, with what you have already done to each one on its face.
 *
 * The colour x size grid cannot be shown on a phone — measured at 292px of 3688px,
 * about two of forty size columns — so entry is split one colour at a time. The cost
 * of splitting it is that the overview disappears: on the grid you can see at a glance
 * that you have filled Black and not yet Navy, and chips alone would take that away.
 *
 * So each chip carries its own count. That is recognition instead of recall — the
 * screen remembers which colours are done, rather than the person having to.
 *
 * `counts` maps colour id to a number; zero or missing shows no badge.
 */
export default function ColorChips({ colors, value, onChange, counts = {}, idPrefix = 'color-chip' }) {
  if (!colors || colors.length <= 0) return null;

  return (
    <div className="phone-chips" role="tablist">
      {colors.map((c) => {
        const active = c.id === value;
        const n = Number(counts[c.id]) || 0;
        return (
          <button
            key={String(c.id)}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`${idPrefix}-${c.id}`}
            className={`phone-chip ${active ? 'phone-chip--on' : ''}`}
            onClick={() => onChange(c.id)}
          >
            <ColorThumb color={c} size="sm" />
            <span className="phone-chip__name">{c.color_name || '—'}</span>
            {n > 0 && <span className="phone-chip__count">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}
