const jwt = require('jsonwebtoken');

const SESSION_TTL = '30d';

function signSession(secret, { sub, email }) {
  return jwt.sign({ sub, email }, secret, { expiresIn: SESSION_TTL });
}

// Devuelve { sub, email } o null si el header falta o el JWT no es válido/venció.
function verifySession(req, secret) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    const payload = jwt.verify(match[1], secret);
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

module.exports = { signSession, verifySession };
