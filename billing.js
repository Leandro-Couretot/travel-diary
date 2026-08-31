// ─── BILLING (Mercado Pago) ────────────────────────────────
// Todo esto habla con las Cloud Functions bajo /api/* — nunca directo con
// Supabase ni con Mercado Pago desde el navegador. El estado de suscripción
// vive en memoria (subState) + un JWT propio en localStorage (td_session,
// mismo patrón que drive_token) para no tener que loguearse de nuevo en
// cada visita.

let sessionToken = localStorage.getItem('td_session') || null;
let subState = { plan: 'free', status: 'none' };

function isPaidUser() {
  return subState.status === 'authorized';
}

// Se llama con el mismo access_token que ya usa Drive, apenas se conecta —
// no hace falta un segundo login para esto.
async function establishSession(googleAccessToken) {
  try {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: googleAccessToken }),
    });
    if (!res.ok) return;
    const data = await res.json();
    sessionToken = data.token;
    localStorage.setItem('td_session', sessionToken);
    subState = { plan: data.plan, status: data.status };
  } catch (e) {
    console.warn('No se pudo establecer la sesión de suscripción:', e);
  }
}

async function refreshSubscriptionStatus() {
  if (!sessionToken) return;
  try {
    const res = await fetch('/api/subscription/status', {
      headers: { Authorization: `Bearer ${sessionToken}` },
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
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planType }),
    });
    if (!res.ok) { alert('No se pudo iniciar la suscripción. Probá de nuevo en un rato.'); return; }
    const { init_point } = await res.json();
    location.href = init_point; // salida externa a Mercado Pago — no es navegación interna de la SPA
  } catch (e) {
    alert('No se pudo iniciar la suscripción: ' + e.message);
  }
}

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
