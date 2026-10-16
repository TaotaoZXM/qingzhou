import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { resetPasswordPage, verifyErrorPage, verifySuccessPage } from './auth-pages.js';
import { createPool, isoTimestamp, migrate, readJsonColumn, utcDateTime } from './db.js';
import { loadEnv } from './env.js';
import { sendPasswordResetEmail, sendVerificationEmail } from './mail.js';
import { sanitizeAppState } from './state-sanitize.js';

loadEnv();

const SESSION_COOKIE = 'qingzhou_session';
const SESSION_TTL = '15d';
const BCRYPT_ROUNDS = 10;
const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const rateBuckets = new Map();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function expiresToSeconds(value) {
  const match = /^(\d+)([smhd])?$/.exec(String(value || '30d'));
  if (!match) return 30 * 24 * 60 * 60;
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  return amount * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function passwordError(password) {
  const value = String(password || '');
  if (value.length < 8) return '密码至少 8 位';
  if (value.length > 128) return '密码不能超过 128 位';
  return '';
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function allowRequest(key, limit, windowMs) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    rateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return true;
}

function readCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) return;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  });
  return cookies;
}

function readToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return readCookies(req.headers.cookie)[SESSION_COOKIE] || '';
}

function cookieSecure(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  return Boolean(req.secure);
}

function writeSessionCookie(req, res, token) {
  const maxAge = expiresToSeconds(SESSION_TTL);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (cookieSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username || null,
    emailVerified: Boolean(row.email_verified_at)
  };
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, requiredEnv('JWT_SECRET'), {
    expiresIn: SESSION_TTL
  });
}

function normalizeUsername(value) {
  const username = String(value || '').trim().replace(/\s+/g, ' ');
  if (!username || /[\u0000-\u001f]/.test(username)) return '';
  if ([...username].length > 20) return '';
  return username;
}

function exposeAuthLinks() {
  // Production responses never include verification or reset tokens.
  // Local/dev can still open the link without a mailbox. EMAIL_DELIVERY only
  // chooses whether Aliyun DirectMail sends the message.
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.EXPOSE_AUTH_LINKS === '0') return false;
  return true;
}

function publicOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function hashResetToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function issueVerificationUrl(pool, userId, req) {
  const rawToken = randomBytes(32).toString('hex');
  await pool.execute('DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL', [userId]);
  await pool.execute(
    'INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [randomUUID(), userId, hashResetToken(rawToken), utcDateTime(new Date(Date.now() + VERIFY_TTL_MS))]
  );
  const verifyUrl = `${publicOrigin(req)}/api/auth/verify?token=${rawToken}`;
  const [rows] = await pool.execute('SELECT email FROM users WHERE id = ? LIMIT 1', [userId]);
  await sendVerificationEmail({ email: rows[0]?.email || '', verifyUrl });
  return verifyUrl;
}

function usableState(state) {
  return Boolean(state && typeof state === 'object' && !Array.isArray(state) && state.version === STATE_VERSION);
}

function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  async function userFromRequest(req) {
    const token = readToken(req);
    if (!token) return null;
    let payload;
    try {
      payload = jwt.verify(token, requiredEnv('JWT_SECRET'));
    } catch {
      return null;
    }
    const userId = String(payload.sub || '');
    if (!userId) return null;
    const [rows] = await pool.execute('SELECT id, email, username, email_verified_at FROM users WHERE id = ? LIMIT 1', [userId]);
    return rows[0] || null;
  }

  function requireUser(req, res, next) {
    userFromRequest(req)
      .then((user) => {
        if (!user) return res.status(401).json({ error: '未登录' });
        req.user = user;
        next();
      })
      .catch(next);
  }

  app.get('/api/health', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    if (!allowRequest(`register:${req.ip}`, 20, 15 * 60 * 1000)) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email) return res.status(400).json({ error: '请填写有效的邮箱' });
    const invalidPassword = passwordError(password);
    if (invalidPassword) return res.status(400).json({ error: invalidPassword });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = { id: randomUUID(), email, username: null, email_verified_at: null };
    const rawToken = randomBytes(32).toString('hex');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [user.id, user.email, passwordHash]);
      await connection.execute(
        'INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        [randomUUID(), user.id, hashResetToken(rawToken), utcDateTime(new Date(Date.now() + VERIFY_TTL_MS))]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该邮箱已注册' });
      throw error;
    } finally {
      connection.release();
    }
    const verifyUrl = `${publicOrigin(req)}/api/auth/verify?token=${rawToken}`;
    await sendVerificationEmail({ email: user.email, verifyUrl });
    res.status(201).json({
      user: publicUser(user),
      verificationRequired: true,
      message: exposeAuthLinks() ? '账号已创建。请打开验证链接，验证后会显示注册成功。' : '账号已创建，请查收验证邮件',
      ...(exposeAuthLinks() ? { verifyUrl } : {})
    });
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    if (!allowRequest(`login:${req.ip}`, 30, 15 * 60 * 1000)) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
    const [rows] = await pool.execute('SELECT id, email, username, email_verified_at, password_hash FROM users WHERE email = ? LIMIT 1', [email]);
    const user = rows[0];
    const matches = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !matches) return res.status(401).json({ error: '邮箱或密码不正确' });
    if (!user.email_verified_at) {
      const body = { error: '请先完成邮箱验证' };
      const verifyUrl = await issueVerificationUrl(pool, user.id, req);
      if (verifyUrl && exposeAuthLinks()) body.verifyUrl = verifyUrl;
      return res.status(403).json(body);
    }
    writeSessionCookie(req, res, signToken(user));
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', asyncRoute(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) return res.status(401).json({ error: '未登录' });
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/auth/forgot-password', asyncRoute(async (req, res) => {
    if (!allowRequest(`reset:${req.ip}`, 8, 15 * 60 * 1000)) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: '请先填写邮箱' });
    const message = exposeAuthLinks()
      ? '如果该邮箱已注册，可以打开下面的重置链接。'
      : '如果该邮箱已注册，重置邮件已发送。';
    const [rows] = await pool.execute('SELECT id, email FROM users WHERE email = ? LIMIT 1', [email]);
    const user = rows[0];
    let resetUrl = '';
    if (user) {
      const rawToken = randomBytes(32).toString('hex');
      await pool.execute('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL', [user.id]);
      await pool.execute(
        'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        [randomUUID(), user.id, hashResetToken(rawToken), utcDateTime(new Date(Date.now() + RESET_TTL_MS))]
      );
      resetUrl = `${publicOrigin(req)}/api/auth/reset?token=${rawToken}`;
      await sendPasswordResetEmail({ email: user.email, resetUrl });
    }
    res.json({ ok: true, message, ...(user && exposeAuthLinks() ? { resetUrl } : {}) });
  }));

  app.post('/api/auth/reset-password', asyncRoute(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    const invalidPassword = passwordError(password);
    if (!token) return res.status(400).json({ error: '缺少重置信息' });
    if (invalidPassword) return res.status(400).json({ error: invalidPassword });
    const [rows] = await pool.execute(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
       LIMIT 1`,
      [hashResetToken(token)]
    );
    const reset = rows[0];
    if (!reset) return res.status(400).json({ error: '重置链接无效或已过期' });
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, reset.user_id]);
    await pool.execute('UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP(3) WHERE id = ?', [reset.id]);
    res.json({ ok: true, message: '密码已更新，请使用新密码登录' });
  }));

  app.get('/api/auth/verify', asyncRoute(async (req, res) => {
    const token = String(req.query.token || '').trim();
    const [rows] = await pool.execute(
      `SELECT t.id, t.user_id, u.email, u.username, u.email_verified_at
       FROM email_verification_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > UTC_TIMESTAMP(3)
       LIMIT 1`,
      [hashResetToken(token)]
    );
    const match = rows[0];
    if (!match) {
      res.status(400).type('html').send(verifyErrorPage('验证链接无效或已过期'));
      return;
    }
    await pool.execute('UPDATE users SET email_verified_at = UTC_TIMESTAMP(3) WHERE id = ? AND email_verified_at IS NULL', [match.user_id]);
    await pool.execute('UPDATE email_verification_tokens SET used_at = UTC_TIMESTAMP(3) WHERE id = ?', [match.id]);
    const user = { id: match.user_id, email: match.email, username: match.username, email_verified_at: new Date() };
    writeSessionCookie(req, res, signToken(user));
    res.type('html').send(verifySuccessPage());
  }));

  app.get('/api/auth/reset', (_req, res) => {
    res.type('html').send(resetPasswordPage());
  });

  app.post('/api/auth/username', requireUser, asyncRoute(async (req, res) => {
    if (!req.user.email_verified_at) return res.status(403).json({ error: '请先完成邮箱验证' });
    const username = normalizeUsername(req.body?.username);
    if (!username) return res.status(400).json({ error: '请填写 1 到 20 个字符的用户名' });
    await pool.execute('UPDATE users SET username = ? WHERE id = ?', [username, req.user.id]);
    res.json({ user: { ...publicUser(req.user), username, emailVerified: true } });
  }));

  app.get('/api/state', requireUser, asyncRoute(async (req, res) => {
    const [rows] = await pool.execute('SELECT state, updated_at FROM user_app_state WHERE user_id = ? LIMIT 1', [req.user.id]);
    const row = rows[0];
    const stored = row ? readJsonColumn(row.state) : null;
    if (!usableState(stored)) {
      res.json({ state: null, updatedAt: row ? isoTimestamp(row.updated_at) : null });
      return;
    }
    const cleaned = sanitizeAppState(stored);
    let updatedAt = row.updated_at;
    if (cleaned.changed) {
      const payload = JSON.stringify(cleaned.state);
      const [result] = await pool.execute(
        `UPDATE user_app_state SET state = ?, updated_at = UTC_TIMESTAMP(3)
         WHERE user_id = ? AND updated_at = ?`,
        [payload, req.user.id, updatedAt]
      );
      if (result.affectedRows) {
        const [fresh] = await pool.execute('SELECT updated_at FROM user_app_state WHERE user_id = ? LIMIT 1', [req.user.id]);
        updatedAt = fresh[0]?.updated_at || updatedAt;
      }
    }
    res.json({
      state: cleaned.state,
      updatedAt: isoTimestamp(updatedAt)
    });
  }));

  app.put('/api/state', requireUser, asyncRoute(async (req, res) => {
    const incoming = req.body?.state;
    if (!usableState(incoming)) return res.status(400).json({ error: '数据格式不正确' });
    const state = sanitizeAppState(incoming).state;
    const payload = JSON.stringify(state);
    if (payload.length > 1_000_000) return res.status(413).json({ error: '数据过大' });
    await pool.execute(
      `INSERT INTO user_app_state (user_id, state, updated_at)
       VALUES (?, ?, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = UTC_TIMESTAMP(3)`,
      [req.user.id, payload]
    );
    const [rows] = await pool.execute('SELECT updated_at FROM user_app_state WHERE user_id = ? LIMIT 1', [req.user.id]);
    res.json({ state, updatedAt: isoTimestamp(rows[0]?.updated_at) });
  }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  const serveStatic = process.env.SERVE_STATIC ? process.env.SERVE_STATIC === '1' : process.env.NODE_ENV !== 'production';
  if (serveStatic) {
    app.use((req, res, next) => {
      let pathName = req.path;
      try {
        pathName = decodeURIComponent(req.path);
      } catch {
        return res.status(404).end();
      }
      const blocked = ['/server', '/deploy', '/.git', '/.github', '/node_modules', '/docs'];
      if (
        pathName.includes('..') ||
        pathName === '/.env' ||
        pathName.endsWith('/.env') ||
        blocked.some((prefix) => pathName === prefix || pathName.startsWith(`${prefix}/`))
      ) {
        return res.status(404).end();
      }
      next();
    });
    app.use(express.static(webRoot, { dotfiles: 'ignore', index: 'index.html' }));
  }

  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: '请求格式不正确' });
    console.error(error);
    if (res.headersSent) return;
    res.status(500).json({ error: '服务器错误' });
  });

  return app;
}

export { createApp };

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const jwtSecret = requiredEnv('JWT_SECRET');
  if (jwtSecret.length < 16) throw new Error('JWT_SECRET must be at least 16 characters');
  const pool = createPool();
  await migrate(pool);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp(pool);
  const server = app.listen(port, host, () => {
    console.log(`qingzhou listening on http://${host}:${port}`);
  });
  const shutdown = async () => {
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
