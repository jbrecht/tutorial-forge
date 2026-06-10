/**
 * Click-highlight overlay: a brief rounded-rect ring around the action target,
 * rendered live in the browser so the raw webm already contains it (v1 —
 * the manifest keeps the data so a later version can composite in post).
 */

export const CALLOUT_INIT_SCRIPT = `
(() => {
  if (window.__forgeCallout) return;
  window.__forgeCallout = (x, y, w, h) => {
    if (!document.documentElement) return;
    const pad = 6;
    const ring = document.createElement('div');
    ring.style.cssText = [
      'position:fixed',
      'left:' + (x - pad) + 'px', 'top:' + (y - pad) + 'px',
      'width:' + (w + pad * 2) + 'px', 'height:' + (h + pad * 2) + 'px',
      'border:3px solid rgba(66,133,244,.9)', 'border-radius:8px',
      'box-shadow:0 0 0 3px rgba(66,133,244,.25)',
      'z-index:2147483645', 'pointer-events:none',
      'opacity:0', 'transition:opacity 120ms ease-in',
    ].join(';');
    document.documentElement.appendChild(ring);
    requestAnimationFrame(() => { ring.style.opacity = '1'; });
    setTimeout(() => {
      ring.style.transition = 'opacity 180ms ease-out';
      ring.style.opacity = '0';
      setTimeout(() => ring.remove(), 200);
    }, 600);
  };
})();
`;

export const CALLOUT_VISIBLE_MS = 600;
