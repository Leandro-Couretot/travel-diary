// ─── DEBUG OVERLAY ───────────────────────────────────────
// Muestra errores JS en pantalla para poder copiarlos desde el celu
// Solo activo si ?debug=1 está en la URL o hay un error

(function() {
  const errors = [];
  let overlay   = null;
  let isVisible = false;
  // No mandar el mismo error mil veces si queda tirando en loop — la idea
  // de reportarlo a Supabase es poder recrearlo después, no llenar la tabla
  // de filas repetidas. Una sola fila por (mensaje+origen) distinto, por
  // carga de página.
  const reportedKeys = new Set();

  const debugMode = new URLSearchParams(location.search).has('debug');

  // Contexto de la app en el momento del error — para poder recrear "dónde,
  // cuándo, a quién y en qué versión" sin tener que pedirle detalles al
  // usuario. Estas variables viven en app.html/billing.js, que cargan
  // DESPUÉS que este archivo (ver los <script> en app.html) — como todos
  // son scripts clásicos (no módulos), comparten un mismo scope global, así
  // que para cuando el error realmente ocurre (mucho después de la carga
  // inicial) ya están definidas. Cada campo se resuelve por separado y con
  // try/catch: si el error pasó MIENTRAS esos scripts todavía se estaban
  // cargando, referenciar una `let`/`const` que todavía no se ejecutó tira
  // ReferenceError (temporal dead zone) — se lo traga y ese campo queda
  // ausente, nunca se pierde el resto del reporte por eso.
  function appContextSnapshot() {
    const ctx = { path: location.pathname, user_agent: navigator.userAgent, online: navigator.onLine };
    try { ctx.app_version = typeof APP_VERSION !== 'undefined' ? APP_VERSION : null; } catch (e) {}
    try { ctx.view = typeof currentView !== 'undefined' ? currentView : null; } catch (e) {}
    try { ctx.tab = typeof currentTab !== 'undefined' ? currentTab : null; } catch (e) {}
    try { ctx.album_id = typeof albumId !== 'undefined' ? albumId : null; } catch (e) {}
    try { ctx.date = typeof currentDate !== 'undefined' ? currentDate : null; } catch (e) {}
    try { ctx.user_email = typeof currentUserEmail !== 'undefined' ? currentUserEmail : null; } catch (e) {}
    return ctx;
  }

  // Manda el error al mismo pipeline de analytics que ya usa el resto de la
  // app (trackEvent() → /api/track → tabla usage_events en Supabase, ver
  // CLAUDE.md → "Métricas de producto") — sin inventar un canal nuevo. Si
  // trackEvent() todavía no existe (billing.js carga después que este
  // archivo — un error puede pasar en esa ventana chica), el reporte queda
  // en cola y billing.js la vacía apenas se define (ver el flush al final
  // de ese archivo).
  function reportError(msg, source, stack) {
    const key = `${msg}|${source}`;
    if (reportedKeys.has(key)) return;
    reportedKeys.add(key);
    const payload = {
      message: String(msg).slice(0, 500),
      source: String(source || '').slice(0, 300),
      stack: stack ? String(stack).slice(0, 2000) : null,
      ...appContextSnapshot(),
    };
    if (typeof window.trackEvent === 'function') {
      window.trackEvent('js_error', payload);
    } else {
      (window.__pendingErrorReports = window.__pendingErrorReports || []).push(payload);
    }
  }

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

  function showError(msg, source, lineno, colno, stack) {
    const time = new Date().toLocaleTimeString('es-AR');
    const entry = {
      time,
      msg: String(msg),
      source: `${source || location.pathname}:${lineno || 0}:${colno || 0}`
    };
    errors.push(entry);
    reportError(entry.msg, entry.source, stack);

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
    showError(e.message, e.filename, e.lineno, e.colno, e.error && e.error.stack);
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', e => {
    const msg = e.reason?.message || String(e.reason) || 'Unhandled promise rejection';
    const stack = e.reason?.stack || '';
    const match = stack.match(/\((.+):(\d+):(\d+)\)/) || stack.match(/at (.+):(\d+):(\d+)/);
    showError(msg, match?.[1] || location.pathname, match?.[2], match?.[3], stack);
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
