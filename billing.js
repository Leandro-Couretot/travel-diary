// ─── BILLING (Mercado Pago) ────────────────────────────────
// Todo esto habla con las Cloud Functions bajo /api/* — nunca directo con
// Supabase ni con Mercado Pago desde el navegador. El estado de suscripción
// vive en memoria (subState) + un JWT propio en localStorage (td_session,
// mismo patrón que drive_token) para no tener que loguearse de nuevo en
// cada visita.

let sessionToken = localStorage.getItem('td_session') || null;
let subState = { plan: 'free', status: 'none' };
let currentUserEmail = null; // se llena en establishSession(), viene ya validado por el servidor

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
// no hace falta un segundo login para esto.
async function establishSession(googleAccessToken) {
  try {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await appCheckHeaders()) },
      body: JSON.stringify({ access_token: googleAccessToken }),
    });
    if (!res.ok) return;
    const data = await res.json();
    sessionToken = data.token;
    localStorage.setItem('td_session', sessionToken);
    subState = { plan: data.plan, status: data.status };
    currentUserEmail = data.email || null;
    // Uno por sesión (cada vez que se resuelve establishSession, sea recién
    // conectado o una sesión restaurada al abrir la app), no por request —
    // ver ANALYTICS_PLAN.md, tabla AARRR.
    trackEvent('login');
  } catch (e) {
    console.warn('No se pudo establecer la sesión de suscripción:', e);
  }
}

async function refreshSubscriptionStatus() {
  if (!sessionToken) return;
  try {
    const res = await fetch('/api/subscription/status', {
      headers: { Authorization: `Bearer ${sessionToken}`, ...(await appCheckHeaders()) },
    });
    if (res.ok) subState = await res.json();
  } catch (e) {
    console.warn('No se pudo refrescar el estado de suscripción:', e);
  }
}

async function startCheckout(planType) {
  if (!sessionToken) { alert('Conectá Drive primero para poder suscribirte.'); return; }
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
