import { HttpError } from '../http.js';
import { createSession, hashPassword, loginAllowed, loginFailed, loginSucceeded, verifyPassword } from '../auth.js';

function sessionCookie(token, maxAge) {
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function validateUser(body) {
  const name = String(body.name ?? '').trim();
  const username = String(body.username ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!name || !username) throw new HttpError(400, 'Informe nome e usuário');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, 'Usuário deve ter de 3 a 30 letras/números, sem espaços');
  if (password.length < 6) throw new HttpError(400, 'A senha precisa ter pelo menos 6 caracteres');
  return { name, username, password };
}

export function registerAuth(router, { db }) {
  const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;

  router.get('/api/setup', () => ({ needed: !hasUsers() }), { public: true });

  router.post('/api/setup', (req) => {
    if (hasUsers()) throw new HttpError(403, 'O sistema já foi configurado');
    const u = validateUser(req.body);
    const { lastInsertRowid } = db.prepare('INSERT INTO users (name, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(u.name, u.username, hashPassword(u.password), new Date().toISOString());
    const s = createSession(db, Number(lastInsertRowid));
    req.setCookie(sessionCookie(s.token, s.maxAge));
    return { ok: true };
  }, { public: true });

  router.post('/api/login', (req) => {
    if (!loginAllowed(req.ip)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username ?? '').trim().toLowerCase());
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
      loginFailed(req.ip);
      throw new HttpError(401, 'Usuário ou senha incorretos');
    }
    loginSucceeded(req.ip);
    const s = createSession(db, user.id);
    req.setCookie(sessionCookie(s.token, s.maxAge));
    return { ok: true };
  }, { public: true });

  router.post('/api/logout', (req) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    req.setCookie(sessionCookie('', 0));
    return { ok: true };
  });

  router.get('/api/me', (req) => req.user);

  router.get('/api/users', () => db.prepare('SELECT id, name, username, created_at FROM users ORDER BY name').all());

  router.post('/api/users', (req) => {
    const u = validateUser(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) throw new HttpError(400, 'Esse usuário já existe');
    db.prepare('INSERT INTO users (name, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(u.name, u.username, hashPassword(u.password), new Date().toISOString());
    return { ok: true };
  });

  router.delete('/api/users/:id', (req) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'Você não pode excluir o próprio usuário');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  router.post('/api/password', (req) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.current ?? ''), user.password_hash)) throw new HttpError(400, 'Senha atual incorreta');
    const next = String(req.body.password ?? '');
    if (next.length < 6) throw new HttpError(400, 'A nova senha precisa ter pelo menos 6 caracteres');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, req.token);
    return { ok: true };
  });
}
