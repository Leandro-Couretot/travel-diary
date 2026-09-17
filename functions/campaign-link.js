const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');

const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// Nombres que nunca son un slug de campaña real — coincide con los archivos
// estáticos del sitio. Firebase Hosting ya les da prioridad sobre este
// rewrite si existen de verdad (ver firebase.json), pero un navegador puede
// pedir cosas como /favicon.ico o /robots.txt que no están entre los
// archivos reales del repo — evita gastar una consulta a Supabase para eso.
const RESERVED_SLUGS = new Set([
  'api', 'app.html', 'index.html', 'diary.html', 'privacy.html', 'terms.html',
  'sw.js', 'manifest.json', 'style.css', 'drive.js', 'billing.js', 'exif.js',
  'debug.js', 'version.json', 'favicon.ico', 'robots.txt', 'apple-touch-icon.png',
]);

// Resuelve "dominio.com.ar/{slug}" (afiliados, puntos de reparto en la
// calle — ver CLAUDE.md → "Atribución de campaña") contra
// travel_diary.campaign_links y redirige a app.html con los UTMs de esa
// fila baked-in. Un slug desconocido (typo, link viejo, o el navegador
// pidiendo favicon.ico) redirige igual a la home SIN UTMs, nunca un 404 —
// un link roto impreso en una tarjeta es peor que perder la atribución de
// esa visita puntual. El destino es siempre una ruta relativa (`/app.html`),
// nunca un dominio hardcodeado — funciona igual sirviéndose desde
// legadofamiliar.com.ar o desde el .web.app viejo.
exports.campaignLink = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY],
  },
  async (req, res) => {
    const slug = String(req.path || '/')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();

    if (!slug || RESERVED_SLUGS.has(slug)) {
      res.redirect(302, '/app.html');
      return;
    }

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      const { data: row } = await supabase
        .from('campaign_links')
        .select('utm_source, utm_medium, utm_campaign')
        .eq('slug', slug)
        .eq('active', true)
        .maybeSingle();

      if (!row) {
        res.redirect(302, '/app.html');
        return;
      }

      const params = new URLSearchParams();
      params.set('utm_source', row.utm_source);
      params.set('utm_medium', row.utm_medium);
      if (row.utm_campaign) params.set('utm_campaign', row.utm_campaign);

      res.redirect(302, `/app.html?${params.toString()}`);
    } catch (e) {
      console.error('campaign-link error:', e);
      res.redirect(302, '/app.html');
    }
  }
);
