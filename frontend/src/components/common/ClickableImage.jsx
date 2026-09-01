import { useState } from 'react';
import ImageViewerModal from './ImageViewerModal';

/**
 * Wraps an <img> so clicking it opens the full ImageViewerModal.
 * Pass any extra props (style, className, etc.) — they go on the <img>.
 *
 * Grids show a small thumbnail; the full-resolution original is only fetched when the
 * viewer actually opens. Pass `thumbSrc` for the small version and `src` for the
 * original — with only `src`, both are the same image and nothing is saved.
 */
export default function ClickableImage({
  src,
  thumbSrc,
  alt,
  title,
  style,
  className,
  width,
  height,
  loading = 'lazy',
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!src && !thumbSrc) return null;

  // Fall back to the original if the thumbnail 404s — images uploaded before
  // thumbnail generation existed have no thumb until the backfill runs.
  const displaySrc = failed || !thumbSrc ? src : thumbSrc;

  return (
    <>
      <img
        src={displaySrc}
        alt={alt || ''}
        className={className}
        // loading="lazy" keeps off-screen images from being fetched at all;
        // decoding="async" keeps decode work off the main thread so long lists
        // don't jank while scrolling.
        loading={loading}
        decoding="async"
        width={width}
        height={height}
        style={{ ...style, cursor: 'zoom-in' }}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        onError={() => { if (thumbSrc && !failed) setFailed(true); }}
        {...rest}
      />
      {open && (
        <ImageViewerModal
          imageUrl={src || thumbSrc}
          title={title || alt || ''}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
