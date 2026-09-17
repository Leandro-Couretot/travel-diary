// ─── BILLING (Mercado Pago) ────────────────────────────────
// Todo esto habla con las Cloud Functions bajo /api/* — nunca directo con
// Supabase ni con Mercado Pago desde el navegador. El estado de suscripción
// vive en memoria (subState) + un JWT propio en localStorage (td_session,
// mismo patrón que drive_token) para no tener que loguearse de nuevo en
// cada visita.

let sessionToken = localStorage.getItem('td_session') || null;
let subState = { plan: 'free', status: 'none' };
let currentUserEmail = null; // se llena en establishSession(), viene ya validado por el servidor
let currentUserPicture = null; // v1.81: avatar del header — mismo origen/validación que currentUserEmail
let currentUserName = null; // v1.81: solo para el alt/title del avatar, no se usa en ningún otro lado

// ─── App Check (reCAPTCHA Enterprise) ──────────────────────────────
// Defensa contra bots/scripts que le peguen directo a /api/* sin pasar por
// esta app en un navegador real — corre invisible (sin ningún desafío
// visible para el usuario), y cada Cloud Function puede exigir un token
// válido antes de ejecutar su lógica (ver CLAUDE.md → "App Check"). Se
// carga siempre (no bajo demanda como ensureJsPdfLoaded() del fotolibro,
// que es opcional) porque el primer pedido a /api/* puede pasar apenas se
// resuelve el login. Mismo criterio de "nunca romper la app si esto falla"
// que ya usa getDebugPlanOverride()/maybeReconcileAudioUsage(): si algo
// acá sale mal, las requests siguen mandándose igual, solo sin el header.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCGH1ovHZ5HaSMUDN3Atwu8S-54dieGUMw',
  authDomain: 'family-fotos-491610.firebaseapp.com',
  projectId: 'family-fotos-491610',
  appId: '1:29099211489:web:68d4251dc368823d81d5a0',
};
const RECAPTCHA_ENTERPRISE_SITE_KEY = '6Ld1abctAAAAAIv8tZA05hd3uGZeMeu4JzVNzbEm';

let _appCheckInstance = null;
function ensureAppCheckInitialized() {
  if (_appCheckInstance) return _appCheckInstance;
  try {
    if (typeof firebase === 'undefined') return null;
    const app = firebase.initializeApp(FIREBASE_CONFIG);
    _appCheckInstance = firebase.appCheck(app);
    _appCheckInstance.activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY), true);
    return _appCheckInstance;
  } catch (e) {
    console.warn('No se pudo inicializar App Check:', e);
    return null;
  }
}

async function appCheckHeaders() {
  try {
    const appCheck = ensureAppCheckInitialized();
    if (!appCheck) return {};
    const { token } = await appCheck.getToken(false);
    return token ? { 'X-Firebase-AppCheck': token } : {};
  } catch (e) {
    console.warn('No se pudo obtener el token de App Check:', e);
    return {};
  }
}

// Variante que devuelve el token en sí (no un header) para sendBeacon()
// (flushTrackEvents), que no puede mandar headers custom — mismo criterio
// que ya usa session_token en el body como fallback para ese caso.
async function appCheckTokenValue() {
  try {
    const appCheck = ensureAppCheckInitialized();
    if (!appCheck) return null;
    const { token } = await appCheck.getToken(false);
    return token || null;
  } catch (e) {
    return null;
  }
}

// ─── Meta Pixel (Fase 3 de GROWTH_PLAN.md) ─────────────────────────
// El snippet base (`fbq`, con el Pixel ID) vive en el <head> de app.html —
// acá solo el wrapper defensivo que usan los call-sites de eventos, mismo
// criterio que appCheckHeaders()/getDebugPlanOverride(): un adblocker que
// bloquee fbevents.js (frecuente, no es un caso raro) nunca puede romper
// nada de la app real, solo perderse ese evento puntual de medición.
// Sincronizar con functions/checkout-create.js → PRECIOS_ARS si cambian
// los precios (mismo comentario de sync que ya usa el texto de los
// botones del modal de suscripción en app.html).
const META_PIXEL_PLAN_PRICES_ARS = { monthly: 14000, annual: Math.round(14000 * 12 * 0.8) };

function trackMetaPixelEvent(eventName, params) {
  try {
    if (typeof fbq !== 'function') return;
    fbq('track', eventName, params || {});
  } catch (e) {
    console.warn('No se pudo trackear el evento de Meta Pixel ' + eventName + ':', e);
  }
}

// ─── Debug: forzar plan localmente, sin tocar Mercado Pago ─────────
// Con un solo usuario de test (el propio dev) no hay forma de probar el
// gating free/pro pagándose a sí mismo o creando una segunda cuenta de
// Google. Este override vive solo en localStorage de este navegador —
// nunca pisa subState real ni habla con /api/**, así que no afecta la
// suscripción real ni lo que ve cualquier otro usuario/dispositivo.
//
// v1.60: antes cualquiera que abriera el modal de ayuda podía forzarse
// Pro y saltear todos los paywalls para siempre (riesgo real documentado
// desde v1.52, sin cerrar hasta ahora). Se restringe a la cuenta del
// propio dev: el override solo tiene efecto si el email de la cuenta de
// Google conectada (currentUserEmail, que sale de establishSession() —
// el servidor ya lo validó contra Google antes de devolverlo, así que no
// es algo que el cliente pueda inventar) está en esta lista. Para
// cualquier otra cuenta, el botón puede seguir estando en localStorage
// de antes (o alguien podría setearlo a mano desde devtools) pero
// isPaidUser() lo ignora igual — la UI además se oculta del todo para
// esas cuentas (ver updateDebugPlanStatus() en app.html).
const DEBUG_PLAN_ALLOWED_EMAILS = ['lcouretot@gmail.com'];

function isDebugPlanAllowed() {
  return !!currentUserEmail && DEBUG_PLAN_ALLOWED_EMAILS.includes(currentUserEmail.toLowerCase());
}

function getDebugPlanOverride() {
  return localStorage.getItem('td_debug_plan'); // 'free' | 'pro' | null (sin override)
}
function setDebugPlanOverride(value) {
  if (value) localStorage.setItem('td_debug_plan', value);
  else localStorage.removeItem('td_debug_plan');
}

function isPaidUser() {
  if (isDebugPlanAllowed()) {
    const override = getDebugPlanOverride();
    if (override) return override === 'pro';
  }
  return subState.status === 'authorized';
}

// Se llama con el mismo access_token que ya usa Drive, apenas se conecta —
// no hace falta un segundo login para esto. Camino legacy: sigue existiendo
// mientras conviven cuentas que todavía no pasaron por el flujo nuevo de
// código de autorización (ver establishSessionWithCode() más abajo y
// CLAUDE.md → "Auth de Drive: de implícito a refresh_token real").
async function establishSession(googleAccessToken) {
  try {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await appCheckHeaders()) },
      body: JSON.stringify({ access_token: googleAccessToken }),
    });
    if (!res.ok) return;
    applySessionResponse(await res.json());
  } catch (e) {
    console.warn('No se pudo establecer la sesión de suscripción:', e);
  }
}

// Flujo nuevo (authorization code, ver CLAUDE.md): manda el `code` que
// entregó `initCodeClient` — el intercambio por tokens reales de Google
// (incluido el refresh_token) pasa del lado del servidor, porque requiere
// el client_secret, que nunca puede vivir en el navegador. A diferencia de
// establishSession() (fire-and-forget, nadie usa lo que devuelve), acá el
// caller SÍ necesita el resultado — es la única forma de conseguir el
// access_token de Drive en sí con este flujo. Devuelve `null` si falla
// (nunca tira), mismo criterio que el resto de esta app para no romper el
// intento de conectar por un error de red pasajero.
async function establishSessionWithCode(code) {
  try {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await appCheckHeaders()) },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    applySessionResponse(data);
    return data;
  } catch (e) {
    console.warn('No se pudo establecer la sesión con el código de autorización:', e);
    return null;
  }
}

function applySessionResponse(data) {
  sessionToken = data.token;
  localStorage.setItem('td_session', sessionToken);
  subState = { plan: data.plan, status: data.status };
  currentUserEmail = data.email || null;
  currentUserPicture = data.picture || null;
  currentUserName = data.name || null;
  // Uno por sesión (cada vez que se resuelve, sea recién conectado o una
  // sesión restaurada al abrir la app), no por request — ver
  // ANALYTICS_PLAN.md, tabla AARRR.
  trackEvent('login');
  // Fase 3d de GROWTH_PLAN.md: señal de signup para Meta Ads, solo la
  // primera vez que esta cuenta de Google se conecta de verdad — nunca en
  // una sesión restaurada ni en un re-login (data.isNewUser lo calcula
  // auth-session.js del lado del servidor, antes del upsert en Supabase,
  // así que no depende de nada que el cliente pueda falsear o perder).
  if (data.isNewUser) trackMetaPixelEvent('CompleteRegistration');
}

// Pide un access_token de Drive nuevo usando el refresh_token guardado del
// lado del servidor (ver drive-token-refresh.js) — reemplaza al refresh
// silencioso basado en cookies de Google del navegador para cualquier
// cuenta que ya pasó por el flujo de código de autorización al menos una
// vez. Autenticado con el JWT de sesión propio (30 días), no con el
// access_token de Drive (que es justo lo que puede estar vencido acá).
// Devuelve `{access_token, expires_in}` o `null` — nunca tira, el caller
// (app.html) decide el fallback (el mecanismo viejo, o pedir reconectar).
async function refreshDriveTokenServerSide() {
  if (!sessionToken) return null;
  try {
    const res = await fetch('/api/drive/token/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, ...(await appCheckHeaders()) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('No se pudo refrescar el access_token de Drive del lado del servidor:', e);
    return null;
  }
}

async function refreshSubscriptionStatus() {
  if (!sessionToken) return;
  try {
    const res = await fetch('/api/subscription/status', {
      headers: { Authorization: `Bearer ${sessionToken}`, ...(await appCheckHeaders()) },
    });
    if (res.ok) {
      const data = await res.json();
      subState = data;
      currentUserEmail = data.email || currentUserEmail;
      currentUserPicture = data.picture || currentUserPicture;
      currentUserName = data.name || currentUserName;
    }
  } catch (e) {
    console.warn('No se pudo refrescar el estado de suscripción:', e);
  }
}

async function startCheckout(planType) {
  if (!sessionToken) { alert('Conectá Drive primero para poder suscribirte.'); return; }
  trackMetaPixelEvent('InitiateCheckout', { value: META_PIXEL_PLAN_PRICES_ARS[planType], currency: 'ARS', content_name: planType });
  try {
    const res = await fetch('/api/checkout/create', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', ...(await appCheckHeaders()) },
      body: JSON.stringify({ planType }),
    });
    if (!res.ok) { alert('No se pudo iniciar la suscripción. Probá de nuevo en un rato.'); return; }
    const { init_point } = await res.json();
    location.href = init_point; // salida externa a Mercado Pago — no es navegación interna de la SPA
  } catch (e) {
    alert('No se pudo iniciar la suscripción: ' + e.message);
  }
}

// ─── Track de uso (Fase 2 de GROWTH_PLAN.md, diseño en ANALYTICS_PLAN.md) ──
// Cada invocación de Cloud Function se cobra por cantidad + tiempo de
// cómputo, con un overhead fijo por request que se paga aunque el trabajo
// real sea mínimo — un evento como tab_viewed puede dispararse varias veces
// por sesión, así que en vez de un POST por evento se juntan en un buffer y
// se mandan en un solo request cada TRACK_FLUSH_MS, o antes si la pestaña se
// oculta/cierra (vía sendBeacon, que sigue viajando aunque la página ya se
// esté cerrando — algo que un fetch() normal puede cortar a mitad de camino).
const TRACK_FLUSH_MS = 12000;
// Mismo set que ANON_ALLOWED_EVENTS en functions/track-event.js — el
// arranque del embudo de registro (modal de onboarding) ocurre antes de que
// exista sesión, así que son los únicos que tiene sentido mandar sin login.
const TRACK_ANON_EVENTS = ['onboarding_viewed', 'signup_started'];
let _eventBuffer = [];
let _trackFlushTimer = null;

function trackEvent(eventName, eventProps = {}) {
  _eventBuffer.push({ event_name: eventName, event_props: eventProps });
  if (!_trackFlushTimer) _trackFlushTimer = setTimeout(() => flushTrackEvents(), TRACK_FLUSH_MS);
}

// debug.js corre antes que este archivo (ver los <script> en app.html) —
// un error real puede pasar en esa ventana chica, antes de que trackEvent()
// exista todavía. Esos reportes quedan en window.__pendingErrorReports en
// vez de perderse (ver reportError() en debug.js) — se vacían acá, apenas
// trackEvent() ya está definido.
if (window.__pendingErrorReports && window.__pendingErrorReports.length) {
  window.__pendingErrorReports.splice(0).forEach(payload => trackEvent('js_error', payload));
}

async function flushTrackEvents(useBeacon = false) {
  if (_trackFlushTimer) { clearTimeout(_trackFlushTimer); _trackFlushTimer = null; }
  if (!_eventBuffer.length) return;
  // Sin sesión todavía, solo los eventos del embudo pre-login tienen sentido
  // mandarse — cualquier otro evento en el buffer se descarta en vez de
  // acumularse esperando un login que puede no llegar nunca (alguien que
  // cierra el modal de onboarding sin conectar Google, por ejemplo).
  const events = sessionToken ? _eventBuffer : _eventBuffer.filter(e => TRACK_ANON_EVENTS.includes(e.event_name));
  _eventBuffer = [];
  if (!events.length) return;
  try {
    if (useBeacon && navigator.sendBeacon) {
      // sendBeacon() no permite mandar headers custom (Authorization ni
      // X-Firebase-AppCheck) — ambos tokens viajan en el body como fallback
      // exclusivamente para este caso; track-event.js los acepta ahí solo
      // cuando no hay header.
      const appCheckToken = await appCheckTokenValue();
      const payload = sessionToken
        ? { events, session_token: sessionToken, app_check_token: appCheckToken }
        : { events, app_check_token: appCheckToken };
      navigator.sendBeacon('/api/track', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      return;
    }
    await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}), ...(await appCheckHeaders()) },
      body: JSON.stringify({ events }),
    });
  } catch (e) {
    console.warn('No se pudieron mandar los eventos de uso:', e);
  }
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTrackEvents(true); });
window.addEventListener('pagehide', () => flushTrackEvents(true));

// Vuelta desde el checkout de Mercado Pago (back_url=/app.html?mp_return=1).
// El webhook puede tardar unos segundos más que el propio redirect, así que
// se reintenta un par de veces antes de asentar el estado en la UI.
async function handleMercadoPagoReturn() {
  const sp = new URLSearchParams(location.search);
  if (!sp.get('mp_return')) return;
  history.replaceState(null, '', location.pathname);
  for (let i = 0; i < 3; i++) {
    await refreshSubscriptionStatus();
    if (isPaidUser()) break;
    await new Promise(r => setTimeout(r, 2000));
  }
}
