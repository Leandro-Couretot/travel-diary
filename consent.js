// consent.js — GA4 + Meta Pixel con el mismo gate de consentimiento (GDPR) que
// ya usa app.html, portado para landing.html/landing-viaje.html.
//
// Mismos IDs, misma versión de consentimiento, mismo Worker de geo y mismo
// criterio geo-diferenciado (Marketing implícito fuera de UE/EEE/UK, Analítica
// siempre opt-in explícito) documentados en CLAUDE.md → "Consentimiento de
// Marketing geo-diferenciado" (v2.30) y "Onboarding personalizado... +
// consentimiento de cookies (GDPR)" (v2.29). Simplificación deliberada frente
// a app.html: sin el modal "Personalizar" (3 categorías con checkboxes) — acá
// solo hay 2 categorías y ningún lugar natural (como el menú de Ayuda) para
// reabrirlo después, así que el banner ofrece directo Aceptar todo/Rechazar +
// un link a privacy.html. Si algún día esto necesita más granularidad, portar
// el modal de app.html tal cual.

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
  var CONSENT_VERSION = 3;
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
  function hasAnalyticsConsent() { var c = getStoredConsent(); return !!(c && c.analytics); }
  function hasMarketingConsent() {
    var c = getStoredConsent();
    if (c) return !!c.marketing;
    return isLikelyNonEuVisitor();
  }

  // ─── Geo (mismo Worker de Cloudflare que app.html, ver cf-geo-worker/) ───
  var GEO_WORKER_URL = 'https://legado-geo.pluxow-ideasverdesymas.workers.dev/';
  var GEO_FETCH_TIMEOUT_MS = 1200;
  var EU_EEA_UK_COUNTRIES = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
    'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO',
    'GB'
  ]);
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
          .finally(function () {
            _geoResolved = true;
            if (timeoutId) clearTimeout(timeoutId);
          });
      })();

  function isLikelyNonEuVisitor() {
    return _geoResolved && !!_geoCountry && !EU_EEA_UK_COUNTRIES.has(_geoCountry);
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
  function maybeApplyImplicitMarketingConsent() {
    if (getStoredConsent()) return;
    if (_metaPixelLoaded) return;
    if (isLikelyNonEuVisitor()) loadMetaPixel();
  }

  // ─── Banner mínimo (inyectado por JS, sin markup en cada landing) ───
  function injectBannerStyles() {
    var style = document.createElement('style');
    style.textContent =
      '.lg-consent-banner{position:fixed;bottom:0;left:0;right:0;z-index:630;' +
      'padding:0.9rem 1.1rem;padding-bottom:calc(0.9rem + env(safe-area-inset-bottom));' +
      'background:#1B1812;color:#fff;display:flex;flex-direction:column;gap:0.7rem;' +
      'box-shadow:0 -4px 20px rgba(0,0,0,0.25);font-family:-apple-system,BlinkMacSystemFont,sans-serif}' +
      '.lg-consent-text{font-size:0.8rem;line-height:1.5;color:rgba(255,255,255,0.85)}' +
      '.lg-consent-text a{color:#E9C08D}' +
      '.lg-consent-actions{display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;justify-content:flex-end}' +
      '.lg-consent-btn{background:none;border:1px solid rgba(255,255,255,0.3);color:#fff;' +
      'padding:0.5rem 0.9rem;border-radius:8px;font-size:0.82rem;font-weight:500;cursor:pointer;white-space:nowrap}' +
      '.lg-consent-btn:hover{border-color:rgba(255,255,255,0.6)}' +
      '.lg-consent-btn-primary{background:#F8F4EA;color:#1B1812;border-color:transparent}';
    document.head.appendChild(style);
  }
  function buildBanner() {
    injectBannerStyles();
    var el = document.createElement('div');
    el.className = 'lg-consent-banner';
    el.innerHTML =
      '<div class="lg-consent-text">Usamos cookies propias y de terceros para medir el uso de la página y entender qué anuncios funcionan. Ver <a href="privacy.html" target="_blank" rel="noopener">Política de Privacidad</a>.</div>' +
      '<div class="lg-consent-actions">' +
      '<button type="button" class="lg-consent-btn" data-act="reject">Rechazar</button>' +
      '<button type="button" class="lg-consent-btn lg-consent-btn-primary" data-act="accept">Aceptar todo</button>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('[data-act="accept"]').addEventListener('click', function () { resolveConsent(true, true); el.remove(); });
    el.querySelector('[data-act="reject"]').addEventListener('click', function () { resolveConsent(false, false); el.remove(); });
  }
  function resolveConsent(analytics, marketing) {
    saveConsent(analytics, marketing);
    applyConsent(analytics, marketing);
  }
  function maybeShowConsentBanner() {
    if (getStoredConsent()) return;
    if (isLikelyNonEuVisitor()) return; // mismo criterio que app.html — no-UE nunca ve el banner
    buildBanner();
  }
  function initConsentGate() {
    var stored = getStoredConsent();
    if (stored) { applyConsent(stored.analytics, stored.marketing); return; }
    maybeApplyImplicitMarketingConsent();
    geoPromise.then(function () {
      maybeApplyImplicitMarketingConsent();
      maybeShowConsentBanner();
    });
  }

  window.LegadoConsent = { hasAnalyticsConsent: hasAnalyticsConsent, hasMarketingConsent: hasMarketingConsent };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsentGate);
  } else {
    initConsentGate();
  }
})();
