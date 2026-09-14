import React, { useState, useRef, useEffect } from 'react';
import {
  HiOutlineMagnifyingGlassPlus,
  HiOutlineMagnifyingGlassMinus,
  HiOutlineArrowDownTray,
  HiOutlineXMark,
} from 'react-icons/hi2';
import { useTranslation } from '../../i18n/i18nContext';

export default function ImageViewerModal({ imageUrl, onClose, title = '' }) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const zoomIn = (e) => { e?.stopPropagation(); setScale(s => Math.min(s + 0.5, 5)); };
  const zoomOut = (e) => {
    e?.stopPropagation();
    setScale(s => {
      const next = Math.max(s - 0.5, 1);
      if (next === 1) setPosition({ x: 0, y: 0 });   // re-centre when back to fit
      return next;
    });
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    try {
      // Fetch the image to trigger a direct download instead of opening a new tab.
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = title || 'image';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      // Cross-origin images can refuse the fetch; opening in a new tab still works.
      window.open(imageUrl, '_blank');
    }
  };

  const handleMouseDown = (e) => {
    // Left button only, and never start a drag from a control.
    if (e.button !== 0 || e.target.closest('button')) return;
    if (scale === 1) return;                 // nothing to pan when fit-to-screen
    setIsDragging(true);
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setPosition({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };

  const handleMouseUp = () => setIsDragging(false);

  // Reset zoom/pan whenever the image changes; close on Escape.
  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [imageUrl]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomIn();
      else if (e.key === '-' || e.key === '_') zoomOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const btn = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
    height: 40,
    border: 'none',
    borderRadius: 'var(--radius-full)',
    background: 'rgba(255, 255, 255, 0.12)',
    color: '#fff',
    cursor: 'pointer',
    transition: 'background 150ms ease',
  };

  return (
    <div
      className="modal-overlay"
      style={{
        zIndex: 9999,
        flexDirection: 'column',
        background: 'rgba(0, 0, 0, 0.92)',
        userSelect: 'none',
        padding: 0,
        backdropFilter: 'blur(2px)',
      }}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={onClose}
    >
      {/* Title */}
      {title && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', top: 16, insetInlineStart: 16, zIndex: 10000,
            color: '#fff', background: 'rgba(0, 0, 0, 0.45)',
            padding: '0.4rem 0.9rem', borderRadius: 'var(--radius-full)',
            fontSize: 'var(--font-size-sm)', maxWidth: '55vw',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
      )}

      {/* Toolbar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', top: 16, insetInlineEnd: 16, zIndex: 10000,
          display: 'flex', gap: '0.5rem',
          background: 'rgba(0, 0, 0, 0.35)', padding: '0.35rem',
          borderRadius: 'var(--radius-full)',
        }}
      >
        <button style={btn} onClick={zoomOut} disabled={scale <= 1}
          title={t('common.zoom_out')} aria-label={t('common.zoom_out')}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.22)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}>
          <HiOutlineMagnifyingGlassMinus size={20} />
        </button>
        <button style={btn} onClick={zoomIn}
          title={t('common.zoom_in')} aria-label={t('common.zoom_in')}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.22)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}>
          <HiOutlineMagnifyingGlassPlus size={20} />
        </button>
        <button style={btn} onClick={handleDownload}
          title={t('common.download')} aria-label={t('common.download')}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.22)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}>
          <HiOutlineArrowDownTray size={20} />
        </button>
        <button style={{ ...btn, background: 'rgba(255,255,255,0.12)' }} onClick={(e) => { e.stopPropagation(); onClose(); }}
          title={t('common.close')} aria-label={t('common.close')}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(225,112,85,0.85)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}>
          <HiOutlineXMark size={22} />
        </button>
      </div>

      {/* Image stage */}
      <div
        style={{
          width: '100vw', height: '100vh',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
          cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-out',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onWheel={(e) => (e.deltaY < 0 ? zoomIn() : zoomOut())}
        onClick={(e) => {
          // A plain click (no drag) at fit-scale closes; otherwise it's ignored so
          // panning doesn't dismiss the viewer.
          if (!isDragging && scale === 1) { e.stopPropagation(); onClose(); }
        }}
      >
        <img
          src={imageUrl}
          alt={title}
          onClick={(e) => e.stopPropagation()}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            maxHeight: '92vh',
            maxWidth: '94vw',
            objectFit: 'contain',
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
            borderRadius: 'var(--radius-sm)',
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}
