import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires.toISOString());
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function userFromToken(db, token) {
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.name, u.username FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString()) || null;
}

// Limite simples de tentativas de login por IP.
const attempts = new Map();
export function loginAllowed(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60000) return true;
  return a.count < 10;
}
export function loginFailed(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60000) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count++;
}
export function loginSucceeded(ip) {
  attempts.delete(ip);
}
