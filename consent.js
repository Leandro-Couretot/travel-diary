// consent.js — GA4 + Meta Pixel con el mismo gate de consentimiento (GDPR) que
// ya usa app.html, portado para landing.html/landing-viaje.html.
//
// Mismos IDs y misma versión de consentimiento que app.html. Desde v2.89,
// opt-in estricto en cualquier país — sin excepción geográfica (ver
// "Funcionando bien" v2.89 en CLAUDE.md; revierte el modelo geo-diferenciado
// de v2.30-v2.35, que sigue documentado ahí como registro histórico).
//
// v2.93: ESTE archivo es, a partir de ahora, la única implementación real del
// banner de cookies para cualquier landing — landing.html/landing-viaje.html
// no tienen ningún markup propio, solo <script src="./consent.js">. Un
// cambio futuro de texto/botones/categorías se hace UNA vez, acá, y las dos
// landing lo heredan solas — pedido explícito del usuario para no mantener
// el mismo banner por separado en cada archivo. Réplica fiel del banner de
// app.html (mismo texto, misma variante GDPR/no-GDPR por geografía) más un
// panel de "Personalizar" inline con las mismas 2 categorías y el mismo
// copy que ya usa el modal "Preferencias de cookies" de app.html — sin
// construir un modal aparte, alcanza con expandir el banner mismo.

(function () {
  'use strict';

  var GA_MEASUREMENT_ID = 'G-0ZM7BKFP5G';
  var META_PIXEL_ID = '1609371220699065';

  // ─── Stubs livianos de gtag()/fbq() — sin tocar la red hasta consentir ───
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());

  !(function (f, b, e, v) {
    if (f.fbq) return;
    var n = (f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    f._legadoLoadPixelScript = function () {
      var t0 = b.createElement(e);
      t0.async = true;
      t0.src = v;
      var s0 = b.getElementsByTagName(e)[0];
      s0.parentNode.insertBefore(t0, s0);
    };
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  // ─── Consentimiento guardado (mismo storage/versión que app.html) ───
  var CONSENT_VERSION = 5; // mismo valor que app.html — ambos leen/escriben el mismo td_consent
  var CONSENT_KEY = 'td_consent';

  function getStoredConsent() {
    try {
      var raw = localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data.version !== CONSENT_VERSION) return null;
      return data;
    } catch (e) { return null; }
  }
  function saveConsent(analytics, marketing) {
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify({
        version: CONSENT_VERSION, analytics: !!analytics, marketing: !!marketing, ts: Date.now()
      }));
    } catch (e) {}
  }
  // Nunca dependen del país — mismo criterio estricto que app.html desde
  // v2.89. El módulo de geo de más abajo (v2.93) solo decide qué botones
  // muestra el banner, jamás esto.
  function hasAnalyticsConsent() { var c = getStoredConsent(); return !!(c && c.analytics); }
  function hasMarketingConsent() { var c = getStoredConsent(); return !!(c && c.marketing); }

  // ─── Geo del banner (v2.93, mismo mecanismo que app.html) ──────────────
  // Decide ÚNICAMENTE qué variante de botones mostrar — GDPR (UE/EEE/UK:
  // Personalizar/Rechazar/Aceptar todo, los 3 con el mismo peso visual) o
  // no (el resto del mundo: Personalizar en gris + "Aceptar todo y
  // continuar" como CTA). Nunca decide si algo carga solo ni el default de
  // ningún checkbox del panel de Personalizar (esos arrancan siempre
  // destildados, en cualquier país).
  var GEO_WORKER_URL = 'https://legado-geo.pluxow-ideasverdesymas.workers.dev/';
  var GEO_FETCH_TIMEOUT_MS = 1200;
  var EU_EEA_UK_COUNTRIES = {
    AT:1,BE:1,BG:1,HR:1,CY:1,CZ:1,DK:1,EE:1,FI:1,FR:1,DE:1,GR:1,HU:1,IE:1,IT:1,
    LV:1,LT:1,LU:1,MT:1,NL:1,PL:1,PT:1,RO:1,SK:1,SI:1,ES:1,SE:1,
    IS:1,LI:1,NO:1,
    GB:1
  };
  var _geoCountry = null;
  var _geoResolved = false;
  function readUtmCountryOverride() {
    try {
      var raw = new URLSearchParams(location.search).get('utm_country');
      if (!raw) return null;
      var code = raw.trim().toUpperCase();
      return /^[A-Z]{2}$/.test(code) ? code : null;
    } catch (e) { return null; }
  }
  var _utmCountryOverride = readUtmCountryOverride();
  var geoPromise = _utmCountryOverride
    ? (function () {
        _geoCountry = _utmCountryOverride;
        _geoResolved = true;
        return Promise.resolve();
      })()
    : (function () {
        var controller = null, timeoutId = null;
        try {
          controller = new AbortController();
          timeoutId = setTimeout(function () { controller.abort(); }, GEO_FETCH_TIMEOUT_MS);
        } catch (e) {}
        return fetch(GEO_WORKER_URL, { cache: 'no-store', signal: controller ? controller.signal : undefined })
          .then(function (res) { return (res && res.ok) ? res.json() : null; })
          .then(function (data) { _geoCountry = (data && data.country) || null; })
          .catch(function () { _geoCountry = null; })
          .then(function () {
            _geoResolved = true;
            if (timeoutId) clearTimeout(timeoutId);
          });
      })();
  // Fail-closed hacia la variante MÁS estricta (GDPR, 3 botones iguales).
  function isLikelyNonEuVisitor() {
    return _geoResolved && !!_geoCountry && !EU_EEA_UK_COUNTRIES[_geoCountry];
  }

  // ─── Carga real (recién con consentimiento) ───
  var _gaLoaded = false, _metaPixelLoaded = false;
  function loadGoogleAnalytics() {
    if (_gaLoaded) return;
    _gaLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    document.head.appendChild(s);
    gtag('config', GA_MEASUREMENT_ID);
  }
  function loadMetaPixel() {
    if (_metaPixelLoaded) return;
    _metaPixelLoaded = true;
    if (typeof window._legadoLoadPixelScript === 'function') window._legadoLoadPixelScript();
    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  }
  function applyConsent(analytics, marketing) {
    if (analytics) loadGoogleAnalytics();
    if (marketing) loadMetaPixel();
  }

  // ─── Banner (inyectado por JS, sin markup propio en cada landing) ───
  function injectBannerStyles() {
    var style = document.createElement('style');
    style.textContent =
      '.lg-consent-banner{position:fixed;bottom:0;left:0;right:0;z-index:630;' +
      'padding:0.9rem 1.1rem;padding-bottom:calc(0.9rem + env(safe-area-inset-bottom));' +
      'background:#1B1812;color:#fff;display:flex;flex-direction:column;gap:0.7rem;' +
      'box-shadow:0 -4px 20px rgba(0,0,0,0.25);font-family:-apple-system,BlinkMacSystemFont,sans-serif}' +
      '.lg-consent-text{font-size:0.8rem;line-height:1.5;color:rgba(255,255,255,0.85)}' +
      '.lg-consent-text a{color:#E9C08D}' +
      '.lg-consent-actions{display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap}' +
      '.lg-consent-link{background:none;border:none;color:rgba(255,255,255,0.7);' +
      'font-family:inherit;font-size:0.78rem;text-decoration:underline;cursor:pointer;' +
      'padding:0.4rem 0;margin-right:auto}' +
      '.lg-consent-link:hover{color:#fff}' +
      '.lg-consent-btn{background:none;border:1px solid rgba(255,255,255,0.3);color:#fff;' +
      'padding:0.5rem 0.9rem;border-radius:8px;font-size:0.82rem;font-weight:500;cursor:pointer;white-space:nowrap}' +
      '.lg-consent-btn:hover{border-color:rgba(255,255,255,0.6)}' +
      '.lg-consent-btn-primary{background:#E9C08D;color:#1B1812;border-color:transparent}' +
      '.lg-consent-btn-primary:hover{background:#dbb078}' +
      '.lg-consent-prefs{display:none;flex-direction:column;gap:0.65rem}' +
      '.lg-consent-cat{display:flex;align-items:flex-start;gap:0.6rem;cursor:pointer}' +
      '.lg-consent-cat input{margin-top:0.2rem;flex-shrink:0;accent-color:#E9C08D}' +
      '.lg-consent-cat-title{font-size:0.82rem;font-weight:600;color:#fff}' +
      '.lg-consent-cat-desc{font-size:0.76rem;line-height:1.45;color:rgba(255,255,255,0.65);margin-top:0.1rem}';
    document.head.appendChild(style);
  }
  // v2.93: GDPR -> 3 botones, mismo peso visual, nunca uno más tentador que
  // otro. No-GDPR -> 2 botones: "Personalizar" en gris + "Aceptar todo y
  // continuar" como CTA principal. Mismo criterio y mismos nombres de clase
  // que applyConsentBannerVariant() en app.html, adaptado a esta banner
  // propia (acá no hay botón "Rechazar" oculto por CSS, se arma distinto
  // directo según la variante porque el markup se construye en JS).
  function bannerActionsHtml(isGdpr) {
    if (isGdpr) {
      return (
        '<button type="button" class="lg-consent-btn" data-act="customize">Personalizar</button>' +
        '<button type="button" class="lg-consent-btn" data-act="reject">Rechazar</button>' +
        '<button type="button" class="lg-consent-btn" data-act="accept">Aceptar todo</button>'
      );
    }
    return (
      '<button type="button" class="lg-consent-link" data-act="customize">Personalizar</button>' +
      '<button type="button" class="lg-consent-btn lg-consent-btn-primary" data-act="accept">Aceptar todo y continuar</button>'
    );
  }
  function buildBanner(isGdpr) {
    injectBannerStyles();
    var el = document.createElement('div');
    el.className = 'lg-consent-banner';
    el.innerHTML =
      '<div class="lg-consent-text">Usamos cookies propias (imprescindibles) y de terceros para medir el uso de la app y llegar a más familias de forma eficiente, <strong>lo que nos ayuda a mantener Legado gratuita</strong>. Podés elegir qué categorías aceptar. Mirá la <a href="privacy.html" target="_blank" rel="noopener">Política de Privacidad</a> para más detalle.</div>' +
      '<div class="lg-consent-actions" data-role="actions">' + bannerActionsHtml(isGdpr) + '</div>' +
      '<div class="lg-consent-prefs" data-role="prefs">' +
        '<label class="lg-consent-cat"><input type="checkbox" data-cat="marketing">' +
        '<div><div class="lg-consent-cat-title">Difusión</div><div class="lg-consent-cat-desc">Aceptarlas ayuda a que Legado pueda seguir ofreciendo una capa gratuita. Al llegar a más familias de forma eficiente, podemos mantener parte de la app sin costo. Tus fotos nunca salen de tu Google Drive ni se comparten con terceros.</div></div></label>' +
        '<label class="lg-consent-cat"><input type="checkbox" data-cat="analytics">' +
        '<div><div class="lg-consent-cat-title">Medición y uso</div><div class="lg-consent-cat-desc">Nos ayuda a arreglar más rápido lo que falla y a saber qué funciones se usan más (y cuáles menos).</div></div></label>' +
        '<button type="button" class="lg-consent-btn lg-consent-btn-primary" data-act="save-prefs" style="width:100%;">Continuar y guardar</button>' +
      '</div>';
    document.body.appendChild(el);

    function remove() { el.parentNode && el.parentNode.removeChild(el); }
    function finish(analytics, marketing) {
      saveConsent(analytics, marketing);
      applyConsent(analytics, marketing);
      remove();
    }
    el.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'accept') { finish(true, true); return; }
      if (act === 'reject') { finish(false, false); return; }
      if (act === 'customize') {
        el.querySelector('[data-role="actions"]').style.display = 'none';
        el.querySelector('[data-role="prefs"]').style.display = 'flex';
        return;
      }
      if (act === 'save-prefs') {
        var analytics = el.querySelector('[data-cat="analytics"]').checked;
        var marketing = el.querySelector('[data-cat="marketing"]').checked;
        finish(analytics, marketing);
        return;
      }
    });
  }
  function resolveConsent(analytics, marketing) {
    saveConsent(analytics, marketing);
    applyConsent(analytics, marketing);
  }
  // Se muestra siempre, en cualquier país, mientras no haya ninguna
  // elección guardada — mismo criterio que app.html desde v2.89. Lo único
  // que varía por país (v2.93) es qué botones ofrece.
  function maybeShowConsentBanner() {
    if (getStoredConsent()) return;
    buildBanner(!isLikelyNonEuVisitor());
  }
  function initConsentGate() {
    var stored = getStoredConsent();
    if (stored) { applyConsent(stored.analytics, stored.marketing); return; }
    // Se espera a que el geo resuelva (o falle, fail-closed) antes de
    // mostrar nada — evita el parpadeo de abrir con una variante de
    // botones y cambiar a la otra un instante después. Mismo costo real
    // que en app.html: hasta 1.2s más en el peor caso.
    geoPromise.then(maybeShowConsentBanner);
  }

  window.LegadoConsent = { hasAnalyticsConsent: hasAnalyticsConsent, hasMarketingConsent: hasMarketingConsent };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsentGate);
  } else {
    initConsentGate();
  }
})();
