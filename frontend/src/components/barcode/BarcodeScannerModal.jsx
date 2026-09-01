import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../i18n/i18nContext';

/**
 * Camera / image barcode scanner, in three tiers that degrade by capability.
 *
 *   1  live stream + native BarcodeDetector   fastest, Chrome/Android      needs HTTPS
 *   2  live stream + ZXing                    iOS Safari has no detector   needs HTTPS
 *   3  photo or file upload + ZXing           always available             NO HTTPS needed
 *
 * Tier 3 is not only the fallback for a missing camera. getUserMedia is gated on a
 * secure context, so on a plain-HTTP deployment tiers 1 and 2 are blocked outright —
 * but <input type="file" capture="environment"> is not, and on a phone it opens the
 * native camera app. That keeps scanning usable over HTTP, one shot at a time.
 *
 * ZXing is ~300 kB, so it is imported dynamically and only when actually needed; it
 * must never land in the initial POS bundle.
 */

function detectCapabilities() {
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const hasCamera = !!navigator.mediaDevices?.getUserMedia;
  const hasNative = typeof window !== 'undefined' && 'BarcodeDetector' in window;
  return {
    secure,
    hasCamera,
    hasNative,
    canStream: secure && hasCamera,
    // Why live streaming is unavailable, so the UI can say something useful rather
    // than just failing.
    blockedReason: !secure ? 'insecure' : !hasCamera ? 'nocamera' : null,
  };
}

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

export default function BarcodeScannerModal({ onDetected, onClose }) {
  const { t } = useTranslation();
  const [caps] = useState(detectCapabilities);
  const [mode, setMode] = useState(() => (detectCapabilities().canStream ? 'stream' : 'upload'));
  const [status, setStatus] = useState('starting');
  const [error, setError] = useState(null);
  const [lastCode, setLastCode] = useState(null);

  const videoRef = useRef(null);
  const fileRef = useRef(null);
  const stopRef = useRef(null);
  const aliveRef = useRef(true);

  const finish = useCallback((code) => {
    if (!aliveRef.current) return;
    setLastCode(code);
    // Small buzz where supported — the cashier is looking at the customer, not the screen.
    try { navigator.vibrate?.(60); } catch { /* not supported */ }
    onDetected?.(code);
  }, [onDetected]);

  // ---------------------------------------------------------------- teardown
  const stopStream = useCallback(() => {
    try { stopRef.current?.(); } catch { /* already gone */ }
    stopRef.current = null;
    const v = videoRef.current;
    if (v?.srcObject) {
      // Every track must be stopped or the camera light stays on after close.
      v.srcObject.getTracks().forEach((tr) => { try { tr.stop(); } catch { /* noop */ } });
      v.srcObject = null;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; stopStream(); };
  }, [stopStream]);

  // ---------------------------------------------------------------- live stream
  useEffect(() => {
    if (mode !== 'stream' || !caps.canStream) return undefined;
    let cancelled = false;

    (async () => {
      setStatus('starting');
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled || !aliveRef.current) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        const v = videoRef.current;
        if (!v) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        v.srcObject = stream;
        v.setAttribute('playsinline', 'true'); // iOS refuses to inline-play without it
        await v.play().catch(() => {});
        setStatus('scanning');

        if (caps.hasNative) {
          // Tier 1 — native detector, polled off rAF.
          const det = new window.BarcodeDetector({ formats: FORMATS });
          let raf = 0;
          const tick = async () => {
            if (cancelled || !aliveRef.current) return;
            try {
              const hits = await det.detect(v);
              if (hits?.length) { finish(hits[0].rawValue); return; }
            } catch { /* transient decode failure; keep going */ }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
          stopRef.current = () => cancelAnimationFrame(raf);
        } else {
          // Tier 2 — ZXing against the same stream.
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (cancelled || !aliveRef.current) return;
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromVideoElement(v, (result) => {
            if (result) finish(result.getText());
          });
          stopRef.current = () => controls.stop();
        }
      } catch (err) {
        if (cancelled) return;
        // NotAllowedError = user said no; NotFoundError = no camera on the device.
        const kind = err?.name === 'NotAllowedError' ? 'denied'
          : err?.name === 'NotFoundError' ? 'nocamera' : 'failed';
        setError(kind);
        setStatus('error');
        setMode('upload'); // fall through to the tier that always works
      }
    })();

    return () => { cancelled = true; stopStream(); };
  }, [mode, caps.canStream, caps.hasNative, finish, stopStream]);

  // ---------------------------------------------------------------- image decode
  async function decodeFile(file) {
    if (!file) return;
    if (!file.type?.startsWith('image/')) { setError('notimage'); setStatus('error'); return; }

    setStatus('decoding');
    setError(null);
    let url;
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser');
      const reader = new BrowserMultiFormatReader();
      url = URL.createObjectURL(file);
      const result = await reader.decodeFromImageUrl(url);
      finish(result.getText());
    } catch {
      // ZXing throws NotFoundException when the image simply has no readable symbol —
      // by far the most common outcome with a blurred or angled photo.
      setError('nocode');
      setStatus('error');
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  function onFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be retried after a failure
    decodeFile(file);
  }

  function onDrop(e) {
    e.preventDefault();
    decodeFile(e.dataTransfer?.files?.[0]);
  }

  const errText = {
    denied: t('barcode.cam_denied'),
    nocamera: t('barcode.cam_none'),
    insecure: t('barcode.cam_insecure'),
    failed: t('barcode.cam_failed'),
    nocode: t('barcode.no_code_in_image'),
    notimage: t('barcode.not_an_image'),
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content card"
        style={{ maxWidth: 520, width: '95%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
          <h2 style={{ margin: 0 }}>{t('barcode.scan')}</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.close')}</button>
        </div>

        {mode === 'stream' && caps.canStream ? (
          <div style={{ position: 'relative', background: '#000', borderRadius: 'var(--radius-md)', overflow: 'hidden', aspectRatio: '4 / 3' }}>
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {/* Aiming guide — a scanner reads a 1D symbol from a horizontal slice. */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ width: '78%', height: '30%', border: '2px solid rgba(255,255,255,.85)', borderRadius: 6, boxShadow: '0 0 0 9999px rgba(0,0,0,.35)' }} />
            </div>
            <div style={{ position: 'absolute', bottom: 8, insetInline: 0, textAlign: 'center', color: '#fff', fontSize: '.85rem', textShadow: '0 1px 3px #000' }}>
              {status === 'scanning' ? t('barcode.point_at_code') : t('common.loading')}
            </div>
          </div>
        ) : (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            style={{
              border: '2px dashed var(--color-border)', borderRadius: 'var(--radius-md)',
              padding: '1.75rem 1rem', textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '2rem', lineHeight: 1, marginBottom: '.5rem' }}>📷</div>
            <div style={{ fontWeight: 600, marginBottom: '.35rem' }}>{t('barcode.take_photo')}</div>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginBottom: '.9rem' }}>
              {caps.blockedReason === 'insecure' ? t('barcode.cam_insecure') : t('barcode.upload_hint')}
            </div>
            {/* capture="environment" opens the rear camera directly on a phone, and a
                file input needs no secure context — this is the HTTP-safe path. */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onFileChange}
              style={{ display: 'none' }}
              data-testid="barcode-file-input"
            />
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={status === 'decoding'}>
              {status === 'decoding' ? t('barcode.decoding') : t('barcode.choose_image')}
            </button>
          </div>
        )}

        {error && (
          <div style={{ marginTop: '.75rem', color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }} role="alert">
            {errText[error] || t('barcode.cam_failed')}
          </div>
        )}

        {lastCode && (
          <div style={{ marginTop: '.75rem', fontFamily: 'monospace' }} data-testid="scanned-code">
            {t('barcode.detected')}: <strong>{lastCode}</strong>
          </div>
        )}

        <div style={{ marginTop: '1rem', display: 'flex', gap: '.5rem', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--color-text-secondary)' }}>
            {caps.canStream
              ? (caps.hasNative ? t('barcode.tier_native') : t('barcode.tier_zxing'))
              : t('barcode.tier_upload')}
          </span>
          {caps.canStream && (
            <button className="btn btn-secondary btn-sm" onClick={() => { stopStream(); setMode(mode === 'stream' ? 'upload' : 'stream'); setError(null); }}>
              {mode === 'stream' ? t('barcode.use_photo') : t('barcode.use_camera')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
