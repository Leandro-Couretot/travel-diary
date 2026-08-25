// ─── DEBUG OVERLAY ───────────────────────────────────────
// Muestra errores JS en pantalla para poder copiarlos desde el celu
// Solo activo si ?debug=1 está en la URL o hay un error

(function() {
  const errors = [];
  let overlay   = null;
  let isVisible = false;

  const debugMode = new URLSearchParams(location.search).has('debug');

  function getOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = '__debug_overlay';
    overlay.innerHTML = `
      <div id="__debug_inner">
        <div id="__debug_header">
          <span>🐛 Errores de consola</span>
          <div style="display:flex;gap:6px;">
            <button id="__debug_copy">Copiar</button>
            <button id="__debug_close">✕</button>
          </div>
        </div>
        <div id="__debug_body"></div>
        <div id="__debug_hint">Compartí este texto para reportar el error</div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById('__debug_close').addEventListener('click', () => {
      overlay.style.display = 'none';
      isVisible = false;
    });
    document.getElementById('__debug_copy').addEventListener('click', () => {
      const text = errors.map(e => `[${e.time}] ${e.msg}\n${e.source}`).join('\n\n');
      navigator.clipboard?.writeText(text).then(() => {
        const btn = document.getElementById('__debug_copy');
        btn.textContent = '✓ Copiado';
        setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
      }).catch(() => {
        // Fallback: select text
        const body = document.getElementById('__debug_body');
        const range = document.createRange();
        range.selectNodeContents(body);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });
    });

    return overlay;
  }

  function showError(msg, source, lineno, colno) {
    const time = new Date().toLocaleTimeString('es-AR');
    const entry = {
      time,
      msg: String(msg),
      source: `${source || location.pathname}:${lineno || 0}:${colno || 0}`
    };
    errors.push(entry);

    const ov = getOverlay();
    ov.style.display = 'flex';
    isVisible = true;

    const body = document.getElementById('__debug_body');
    const item = document.createElement('div');
    item.className = '__debug_item';
    item.innerHTML = `
      <div class="__debug_time">${time}</div>
      <div class="__debug_msg">${escapeHtml(entry.msg)}</div>
      <div class="__debug_src">${escapeHtml(entry.source)}</div>`;
    body.appendChild(item);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Capture global errors
  window.addEventListener('error', e => {
    showError(e.message, e.filename, e.lineno, e.colno);
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', e => {
    const msg = e.reason?.message || String(e.reason) || 'Unhandled promise rejection';
    const stack = e.reason?.stack || '';
    const match = stack.match(/\((.+):(\d+):(\d+)\)/) || stack.match(/at (.+):(\d+):(\d+)/);
    showError(msg, match?.[1] || location.pathname, match?.[2], match?.[3]);
  });

  // Also intercept console.error in debug mode
  if (debugMode) {
    const origError = console.error.bind(console);
    console.error = (...args) => {
      origError(...args);
      showError(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), location.pathname, 0, 0);
    };
  }

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #__debug_overlay {
      display: none;
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 99999;
      align-items: flex-end;
      justify-content: center;
      padding: 1rem;
      font-family: -apple-system, monospace;
    }
    #__debug_inner {
      background: #1a1a18;
      color: #f0e8d8;
      border-radius: 10px;
      width: 100%;
      max-width: 540px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #__debug_header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      font-size: 0.85rem; font-weight: 600;
      flex-shrink: 0;
    }
    #__debug_header button {
      background: rgba(255,255,255,0.15);
      border: none; color: white; border-radius: 4px;
      padding: 0.25rem 0.6rem; font-size: 0.75rem; cursor: pointer;
    }
    #__debug_body {
      flex: 1; overflow-y: auto;
      padding: 0.75rem 1rem;
      display: flex; flex-direction: column; gap: 0.75rem;
    }
    .__debug_item { border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.75rem; }
    .__debug_item:last-child { border-bottom: none; }
    .__debug_time { font-size: 0.65rem; color: rgba(255,255,255,0.4); margin-bottom: 0.2rem; }
    .__debug_msg { font-size: 0.82rem; color: #ff8080; word-break: break-all; margin-bottom: 0.2rem; }
    .__debug_src { font-size: 0.72rem; color: rgba(255,255,255,0.4); word-break: break-all; }
    #__debug_hint {
      padding: 0.5rem 1rem;
      font-size: 0.72rem; color: rgba(255,255,255,0.3);
      text-align: center; flex-shrink: 0;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
  `;
  document.head.appendChild(style);
})();
