/**
 * Fake-cursor overlay. Playwright fires real input events but renders no
 * cursor; we inject one and move it explicitly before instrumented actions.
 * Everything is namespaced under __forge_* and pointer-events: none —
 * graceful degradation, never interference.
 */

export const CURSOR_INIT_SCRIPT = `
(() => {
  if (window.__forgeCursor) return;

  const ensure = () => {
    let el = document.getElementById('__forge_cursor__');
    if (el) return el;
    if (!document.documentElement) return null;
    el = document.createElement('div');
    el.id = '__forge_cursor__';
    el.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:24px', 'height:24px',
      'z-index:2147483647', 'pointer-events:none',
      'transform:translate(-100px,-100px)',
      'transition:transform 350ms cubic-bezier(.25,.1,.25,1)',
      'filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))',
    ].join(';');
    el.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24">'
      + '<path d="M5 2 L5 19 L9.5 15 L12.5 21.5 L15 20.3 L12 14 L18 14 Z"'
      + ' fill="white" stroke="black" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);
    return el;
  };

  window.__forgeCursor = {
    moveTo(x, y) {
      const el = ensure();
      if (el) el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    },
    pulse(x, y) {
      if (!document.documentElement) return;
      const p = document.createElement('div');
      p.style.cssText = [
        'position:fixed', 'left:' + (x - 18) + 'px', 'top:' + (y - 18) + 'px',
        'width:36px', 'height:36px', 'border-radius:50%',
        'background:rgba(66,133,244,.45)', 'z-index:2147483646',
        'pointer-events:none', 'transform:scale(.3)', 'opacity:1',
        'transition:transform 300ms ease-out, opacity 300ms ease-out',
      ].join(';');
      document.documentElement.appendChild(p);
      requestAnimationFrame(() => {
        p.style.transform = 'scale(1.6)';
        p.style.opacity = '0';
      });
      setTimeout(() => p.remove(), 350);
    },
  };

  if (document.readyState !== 'loading') ensure();
  else document.addEventListener('DOMContentLoaded', ensure, { once: true });
})();
`;

/** Duration of the cursor's CSS transition; instrumented actions wait this long after moveTo. */
export const CURSOR_TRAVEL_MS = 350;
