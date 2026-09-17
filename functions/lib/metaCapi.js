// Meta Conversions API — compartido entre las Cloud Functions que disparan
// un evento del funnel de Ads desde el servidor (ver CLAUDE.md → "Meta Ads:
// funnel completo instrumentado"). Empezó viviendo solo en
// webhook-mercadopago.js (Subscribe, único evento server-side de la Fase 3
// original) — se extrajo acá cuando auth-session.js y checkout-create.js
// sumaron su propio evento hybrid (CompleteRegistration/InitiateCheckout),
// para no triplicar la misma llamada a la Graph API en 3 archivos.

// No es un dato sensible — mismo valor que ya vive hardcodeado en el <head>
// de app.html (snippet base del Pixel).
const META_PIXEL_ID = '1609371220699065';

// `_fbp`/`_fbc` son cookies de PRIMERA parte que pone el Pixel de Meta en
// este mismo dominio (fbevents.js, cargado en app.html) — como cada endpoint
// que las lee es same-origin (rewrite de Firebase Hosting hacia la Cloud
// Function), viajan solas en el header Cookie del pedido, sin que el
// frontend tenga que mandarlas a mano.
function readFbCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// Manda un evento a la Conversions API de Meta — best-effort, nunca puede
// romper el flujo real que lo dispara (un fetch que tira o una respuesta
// no-ok solo se loguean). Deliberadamente SIN ningún dato personal del
// usuario (email/teléfono, ni hasheado) — decisión explícita del usuario,
// misma postura que esta app ya tiene con Google Analytics (nunca PII) — el
// matching se apoya solo en `fbp`/`fbc`. Sin ninguna de las dos (adblocker,
// o el pedido nunca pasó por un navegador con el Pixel activo) no se manda
// nada — Meta rechaza un evento sin al menos un identificador, así que
// mandar uno vacío sería peor que no mandar nada.
//
// `eventId` (opcional): cuando el mismo evento lógico también se manda por
// Pixel del lado del cliente (CompleteRegistration, InitiateCheckout — los
// dos únicos con un momento server-side útil, ver CLAUDE.md), pasar el MISMO
// id que usó la llamada de Pixel acá — es el mecanismo oficial de Meta para
// deduplicar las dos llegadas del mismo evento en una sola conversión.
async function sendMetaCapiEvent({ eventName, eventId, fbp, fbc, customData, accessToken }) {
  if (!fbp && !fbc) return;
  try {
    const userData = {};
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;
    const event = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      user_data: userData,
    };
    if (eventId) event.event_id = eventId;
    if (customData) event.custom_data = customData;
    const res = await fetch(`https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event] }),
    });
    if (!res.ok) console.error(`Meta Conversions API error (${eventName}):`, await res.text());
  } catch (e) {
    console.error(`No se pudo mandar el evento ${eventName} a Meta Conversions API:`, e);
  }
}

module.exports = { readFbCookie, sendMetaCapiEvent, META_PIXEL_ID };
