import ClickableImage from '../common/ClickableImage';
import './ColorThumb.css';

/**
 * A colour, shown as a picture.
 *
 * Receiving a delivery means matching what is in the box against a name in a list, and
 * "Olive" and "Sand" are a great deal easier to tell apart as photographs than as
 * words — particularly for whoever is unpacking, who did not name them.
 *
 * THREE STATES, AND THE THIRD IS THE ONE THAT MATTERS.
 *   1. a photo, when the colour has one
 *   2. the colour's own hex, when it was given one but no photo
 *   3. its initial on a plain tile, when it has neither
 *
 * Without the third it renders as an empty hole and reads as something failing to
 * load. A deliberate placeholder reads as "no photo for this one yet", which is true
 * and is not an error.
 *
 * `thumb_url` is preferred over `image_url`: these appear a dozen at a time in a
 * dropdown, and the originals are up to 10 MB each.
 */

/** The image a colour should be represented by: its primary, else its first. */
export function primaryImage(color) {
  const images = color?.images || [];
  if (!images.length) return null;
  return images.find((i) => i.is_primary) || images[0];
}

export default function ColorThumb({ color, size = 'sm', zoomable = false, className = '' }) {
  if (!color) return null;

  const image = primaryImage(color);
  const extra = Math.max(0, (color.images || []).length - 1);
  const name = color.color_name || '';
  const cls = `color-thumb color-thumb--${size} ${className}`.trim();

  if (image) {
    const src = image.image_url;
    const thumb = image.thumb_url || image.image_url;
    return (
      <span className={`${cls} color-thumb--photo`} title={name}>
        {zoomable
          ? <ClickableImage src={src} thumbSrc={thumb} alt={name} className="color-thumb__img" />
          : <img src={thumb} alt={name} className="color-thumb__img" loading="lazy" decoding="async" />}
        {/* Says there is more to see without opening anything. */}
        {extra > 0 && size !== 'sm' && <span className="color-thumb__more">+{extra}</span>}
      </span>
    );
  }

  if (color.hex_code) {
    return (
      <span
        className={`${cls} color-thumb--hex`}
        style={{ background: color.hex_code }}
        title={`${name} · ${color.hex_code}`}
      />
    );
  }

  return (
    <span className={`${cls} color-thumb--empty`} title={name} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
