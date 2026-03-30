import { useState } from 'react';
import ImageViewerModal from './ImageViewerModal';

/**
 * Wraps an <img> so clicking it opens the full ImageViewerModal.
 * Pass any extra props (style, className, etc.) — they go on the <img>.
 */
export default function ClickableImage({ src, alt, title, style, className, ...rest }) {
  const [open, setOpen] = useState(false);

  if (!src) return null;

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className={className}
        style={{ ...style, cursor: 'zoom-in' }}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        {...rest}
      />
      {open && (
        <ImageViewerModal
          imageUrl={src}
          title={title || alt || ''}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
