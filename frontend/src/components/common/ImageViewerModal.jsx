import React, { useState, useRef, useEffect } from 'react';

export default function ImageViewerModal({ imageUrl, onClose, title = 'Image' }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const handleZoomIn = (e) => {
    e.stopPropagation();
    setScale(s => Math.min(s + 0.5, 4));
  };
  
  const handleZoomOut = (e) => {
    e.stopPropagation();
    setScale(s => Math.max(s - 0.5, 0.5));
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    try {
      // Fetch the image to trigger a direct download instead of opening in a new tab
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = title || 'downloaded-image';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download image:', err);
      // Fallback
      window.open(imageUrl, '_blank');
    }
  };
  
  const handleMouseDown = (e) => {
    // Only allow dragging with the left mouse button, and prevent dragging if clicking buttons
    if (e.button !== 0 || e.target.tagName === 'BUTTON' || e.target.tagName === 'A') return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };
  
  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setPosition({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };
  
  const handleMouseUp = () => setIsDragging(false);

  // Reset zoom/pan if the URL changes
  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [imageUrl]);

  return (
    <div 
      className="modal-overlay" 
      style={{ 
        zIndex: 9999, 
        flexDirection: 'column', 
        backgroundColor: 'rgba(0, 0, 0, 0.9)', // Darker background for image viewer
        userSelect: 'none'
      }} 
      onMouseUp={handleMouseUp} 
      onMouseLeave={handleMouseUp}
    >
       {/* Toolbar */}
       <div style={{ position: 'absolute', top: 20, right: 20, display: 'flex', gap: 'var(--spacing-sm)', zIndex: 10000 }}>
          <button className="btn btn-secondary" onClick={handleZoomIn} title="Zoom In">🔍 +</button>
          <button className="btn btn-secondary" onClick={handleZoomOut} title="Zoom Out">🔍 -</button>
          <button className="btn btn-primary" onClick={handleDownload} title="Download Image">⬇ Download</button>
          <button className="btn btn-danger" onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close Viewer">✖ Close</button>
       </div>

       {/* Title */}
       {title && (
          <div style={{ position: 'absolute', top: 20, left: 20, color: 'white', zIndex: 10000, backgroundColor: 'rgba(0, 0, 0, 0.5)', padding: '5px 15px', borderRadius: 20 }}>
            {title}
          </div>
       )}
       
       {/* Image Container */}
       <div 
         style={{ 
           overflow: 'hidden', 
           width: '100vw', 
           height: '100vh', 
           display: 'flex', 
           alignItems: 'center', 
           justifyContent: 'center', 
           cursor: isDragging ? 'grabbing' : 'pointer' 
         }}
         onMouseDown={handleMouseDown} 
         onMouseMove={handleMouseMove}
         onClick={(e) => {
           // Close on tap/click if the user hasn't dragged
           if (!isDragging && scale === 1) { e.stopPropagation(); onClose(); }
         }}
       >
         <img 
           src={imageUrl} 
           alt={title} 
           style={{ 
             transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`, 
             transition: isDragging ? 'none' : 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
             maxHeight: '90vh',
             maxWidth: '90vw',
             objectFit: 'contain' // Ensures the entire image is visible initially
           }} 
           draggable={false}
         />
       </div>
    </div>
  );
}
