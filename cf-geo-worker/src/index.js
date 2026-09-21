// Worker de geolocalización para el consentimiento de cookies (GDPR) — ver
// CLAUDE.md → "Consentimiento de cookies (GDPR)" en app.html para el porqué.
//
// No hace ninguna consulta a una base de datos ni a una API externa: Cloudflare
// ya resuelve el país de cada pedido en su propio borde de red (misma señal que
// usan la mayoría de los CMPs comerciales) y lo expone en `request.cf.country`
// — este Worker solo lo devuelve tal cual, como JSON.
//
// Deliberadamente sin ningún dato personal ni de sesión — un código de país
// (ISO 3166-1 alpha-2, ej. "AR", "ES") no identifica a nadie, es la misma
// clase de dato que ya usa cualquier selector de idioma/moneda de una tienda.
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const country = (request.cf && request.cf.country) || null;
    return new Response(JSON.stringify({ country }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders() },
    });
  },
};

function corsHeaders() {
  // Sin credenciales (no cookies, no Authorization) — un país no es un dato
  // sensible, así que un origin abierto es seguro acá; no hay nada que
  // restringir por dominio.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}
