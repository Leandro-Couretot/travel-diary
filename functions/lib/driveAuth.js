// v2.61: helper compartido para intercambiar un refresh_token de Drive por
// un access_token fresco — misma llamada que ya usaba drive-token-refresh.js
// en solitario (ver CLAUDE.md → "Auth de Drive: de implícito a refresh_token
// real", v1.91), extraída acá porque shared-album-proxy.js la necesita
// también, para mintear un access_token del DUEÑO de un álbum compartido
// (no del invitado que hace el pedido) — ver "El scope drive.file no da
// acceso al contenido de una carpeta compartida" en CLAUDE.md.
async function mintAccessTokenFromRefreshToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = new Error('drive_refresh_token_exchange_failed');
    err.invalidGrant = true; // Google devuelve esto típicamente por invalid_grant (revocado/expirado)
    throw err;
  }
  const tokens = await res.json(); // { access_token, expires_in, scope, token_type }
  return { accessToken: tokens.access_token, expiresIn: tokens.expires_in };
}

module.exports = { mintAccessTokenFromRefreshToken };
