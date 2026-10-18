import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';

process.env.JWT_SECRET = 'test-secret-value-123456';
process.env.NODE_ENV = 'production';
delete process.env.EXPOSE_DEV_LINKS;
delete process.env.EMAIL_DELIVERY;
delete process.env.PASSWORD_RESET_DELIVERY;
delete process.env.ADMIN_USERNAME;
delete process.env.ADMIN_PASSWORD_HASH;

const { createApp } = await import('../src/index.js');
const { migrate } = await import('../src/db.js');
const { ensureAdminUser } = await import('../src/admin-user.js');

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, '..', '..', 'index.html'), 'utf8');

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

function loadClientHelpers() {
  const start = html.indexOf('function readStoredAppState()');
  const end = html.indexOf('function saveLocalAppState()');
  assert.ok(start > 0 && end > start, 'client helpers were not found in index.html');
  const context = {
    localStorage: memoryStorage(),
    currentUser: null,
    cloudUpdatedAt: null,
    cloudBaseState: null,
    appStateStorageKey: 'lightboat-app-state-v1',
    appStateOwnerKey: 'lightboat-app-state-owner-v1',
    cloudMetaKeyPrefix: 'lightboat-cloud-base-v1:'
  };
  createContext(context);
  runInContext(`${html.slice(start, end)}
    globalThis.readStoredAppState = readStoredAppState;
    globalThis.localOwnerId = localOwnerId;
    globalThis.archiveLocalState = archiveLocalState;
    globalThis.restoreLocalState = restoreLocalState;
    globalThis.canUploadLocalState = canUploadLocalState;
    globalThis.mergeAppState = mergeAppState;
    globalThis.appStateSignature = appStateSignature;
  `, context);
  return context;
}

function assertNoAuthMaterial(body) {
  const text = JSON.stringify(body);
  assert.equal(/resetUrl|verifyUrl|"token"|token=|password_hash|token_hash/i.test(text), false, text);
}

function productionEnv() {
  process.env.NODE_ENV = 'production';
  delete process.env.EXPOSE_DEV_LINKS;
  delete process.env.EMAIL_DELIVERY;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD_HASH;
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    async request(path, { method = 'GET', body, cookie } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed, headers: response.headers };
    },
    cookieFrom(response) {
      const raw = response.headers.get('set-cookie') || '';
      const pair = raw.split(';')[0];
      assert.match(pair, /^qingzhou_session=/);
      return pair;
    }
  };
}

const pool = mysql.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: 'qingzhou',
  password: 'qingzhou',
  database: 'qingzhou_test',
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true
});
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

test.before(async () => {
  await migrate(pool);
  await migrate(pool);
  await pool.query('DELETE FROM email_verification_tokens');
  await pool.query('DELETE FROM password_reset_tokens');
  await pool.query('DELETE FROM user_app_state');
  await pool.query('DELETE FROM users');
});

test.after(async () => {
  await pool.end();
});

test('client keeps another user and unknown local state out of the new account', () => {
  const client = loadClientHelpers();
  client.localStorage.setItem('lightboat-app-state-v1', JSON.stringify({ version: 1, todo: [{ id: 'legacy', title: 'offline' }] }));
  assert.equal(client.canUploadLocalState('user-b'), false);
  client.archiveLocalState();
  assert.equal(
    JSON.parse(client.localStorage.getItem('lightboat-app-state-v1:unowned')).todo[0].id,
    'legacy'
  );

  client.localStorage.setItem('lightboat-app-state-owner-v1', 'user-a');
  client.localStorage.setItem('lightboat-app-state-v1', JSON.stringify({ version: 1, todo: [{ id: 'a-task', title: 'A' }] }));
  client.archiveLocalState();
  client.localStorage.removeItem('lightboat-app-state-v1');
  client.localStorage.removeItem('lightboat-app-state-owner-v1');
  assert.equal(client.restoreLocalState('user-b'), false);
  assert.equal(client.canUploadLocalState('user-b'), false);
  assert.equal(JSON.parse(client.localStorage.getItem('lightboat-app-state-v1:user-a')).todo[0].id, 'a-task');
  assert.equal(client.restoreLocalState('user-a'), true);
  assert.equal(client.canUploadLocalState('user-a'), true);
  assert.equal(client.canUploadLocalState('user-b'), false);
});

test('client merges stale cloud saves instead of dropping either side', () => {
  const client = loadClientHelpers();
  const base = {
    version: 1,
    todo: [{ id: 't1', title: 'A', note: 'base' }],
    done: [],
    ideas: [{ text: 'keep', createdAt: '2026-01-01T00:00:00.000Z' }],
    feedback: [],
    projects: ['舟']
  };
  const local = {
    version: 1,
    todo: [{ id: 't1', title: 'A edited', note: 'base' }, { id: 't2', title: 'local only' }],
    done: [],
    ideas: [],
    feedback: [],
    projects: ['舟', '本地']
  };
  const server = {
    version: 1,
    todo: [{ id: 't1', title: 'A', note: 'server note' }],
    done: [{ id: 'd1', title: 'done on server' }],
    ideas: [{ text: 'keep', createdAt: '2026-01-01T00:00:00.000Z' }, { text: 'from server', createdAt: '2026-01-02T00:00:00.000Z' }],
    feedback: [],
    projects: ['舟']
  };
  const merged = client.mergeAppState(base, local, server);
  assert.equal(merged.todo.find((item) => item.id === 't1').title, 'A edited');
  assert.equal(merged.todo.find((item) => item.id === 't1').note, 'server note');
  assert.ok(merged.todo.find((item) => item.id === 't2'));
  assert.ok(merged.done.find((item) => item.id === 'd1'));
  assert.equal(JSON.stringify(merged.ideas.map((item) => item.text)), JSON.stringify(['from server']));
  assert.equal(JSON.stringify(merged.projects), JSON.stringify(['舟', '本地']));

  const withoutBase = client.mergeAppState(null, { version: 1, todo: [{ id: 'local', title: 'L' }], done: [], ideas: [], feedback: [], projects: [] }, server);
  assert.ok(withoutBase.todo.find((item) => item.id === 'local'));
  assert.ok(withoutBase.todo.find((item) => item.id === 't1'));
  assert.ok(withoutBase.done.find((item) => item.id === 'd1'));
});

test('production auth responses never include reset or verification links', async () => {
  productionEnv();
  const app = createApp(pool);
  const http = await listen(app);
  try {
    const email = 'owner@example.com';
    const password = 'password123';
    const registered = await http.request('/api/auth/register', { method: 'POST', body: { email, password } });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.verificationRequired, false);
    assert.equal(registered.body.user.emailVerified, true);
    assert.equal(registered.body.message, '账号已创建，可以登录');
    assertNoAuthMaterial(registered.body);
    const [verifyRows] = await pool.execute('SELECT id FROM email_verification_tokens');
    assert.equal(verifyRows.length, 0);

    const loggedIn = await http.request('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(loggedIn.status, 200);
    assertNoAuthMaterial(loggedIn.body);
    const cookie = http.cookieFrom(loggedIn);
    const token = decodeURIComponent(cookie.split('=')[1]);
    const session = jwt.decode(token);
    assert.equal(session.tv, 0);
    assert.equal(session.exp - session.iat, 7 * 24 * 60 * 60);

    const missing = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email: 'missing@example.com' } });
    const known = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email } });
    assert.equal(missing.status, 503);
    assert.equal(known.status, 503);
    assert.equal(missing.body.error, '找回密码暂不可用，请联系管理员');
    assert.deepEqual(missing.body, known.body);
    assertNoAuthMaterial(known.body);
    const [resetRows] = await pool.execute('SELECT id FROM password_reset_tokens');
    assert.equal(resetRows.length, 0);

    process.env.EXPOSE_DEV_LINKS = '1';
    const forced = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email } });
    assert.equal(forced.status, 503);
    assertNoAuthMaterial(forced.body);
    const registeredAgain = await http.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'second@example.com', password }
    });
    assert.equal(registeredAgain.status, 201);
    assert.equal(registeredAgain.body.verificationRequired, false);
    assertNoAuthMaterial(registeredAgain.body);
  } finally {
    productionEnv();
    await new Promise((resolve) => http.server.close(resolve));
  }
});

test('password reset revokes outstanding sessions', async () => {
  productionEnv();
  const app = createApp(pool);
  const http = await listen(app);
  try {
    const email = 'reset@example.com';
    const password = 'password123';
    const nextPassword = 'newpassword123';
    const registered = await http.request('/api/auth/register', { method: 'POST', body: { email, password } });
    assert.equal(registered.status, 201);
    const loggedIn = await http.request('/api/auth/login', { method: 'POST', body: { email, password } });
    const cookie = http.cookieFrom(loggedIn);
    assert.equal((await http.request('/api/auth/me', { cookie })).status, 200);

    process.env.NODE_ENV = 'development';
    process.env.EXPOSE_DEV_LINKS = '1';
    const forgot = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email } });
    assert.equal(forgot.status, 200);
    assert.match(forgot.body.resetUrl, /\/api\/auth\/reset\?token=/);
    const resetToken = new URL(forgot.body.resetUrl).searchParams.get('token');
    productionEnv();

    const reset = await http.request('/api/auth/reset-password', {
      method: 'POST',
      body: { token: resetToken, password: nextPassword }
    });
    assert.equal(reset.status, 200);
    assertNoAuthMaterial(reset.body);
    assert.equal((await http.request('/api/auth/me', { cookie })).status, 401);
    assert.equal((await http.request('/api/auth/login', { method: 'POST', body: { email, password } })).status, 401);
    const relogin = await http.request('/api/auth/login', { method: 'POST', body: { email, password: nextPassword } });
    assert.equal(relogin.status, 200);
    const nextCookie = http.cookieFrom(relogin);
    assert.equal(jwt.decode(decodeURIComponent(nextCookie.split('=')[1])).tv, 1);
    assert.equal((await http.request('/api/auth/me', { cookie })).status, 401);
    assert.equal((await http.request('/api/auth/me', { cookie: nextCookie })).status, 200);
  } finally {
    productionEnv();
    await new Promise((resolve) => http.server.close(resolve));
  }
});

test('configured mail still does not return links, and dev opt-in does', async () => {
  process.env.NODE_ENV = 'production';
  process.env.EMAIL_DELIVERY = 'directmail';
  delete process.env.EXPOSE_DEV_LINKS;
  const app = createApp(pool);
  const http = await listen(app);
  try {
    const email = 'mail@example.com';
    const password = 'password123';
    const registered = await http.request('/api/auth/register', { method: 'POST', body: { email, password } });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.verificationRequired, true);
    assertNoAuthMaterial(registered.body);
    const [verifyRows] = await pool.execute(
      'SELECT t.id FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?',
      [email]
    );
    assert.equal(verifyRows.length, 1);
    const blocked = await http.request('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, '请先完成邮箱验证');
    assertNoAuthMaterial(blocked.body);

    const forgot = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email } });
    assert.equal(forgot.status, 200);
    assert.match(forgot.body.message, /重置邮件已发送/);
    assertNoAuthMaterial(forgot.body);
    const [resetRows] = await pool.execute(
      'SELECT t.id FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?',
      [email]
    );
    assert.equal(resetRows.length, 1);

    process.env.NODE_ENV = 'development';
    process.env.EXPOSE_DEV_LINKS = '1';
    const devForgot = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email: 'nobody-dev@example.com' } });
    assert.equal(devForgot.status, 200);
    assert.equal(devForgot.body.resetUrl, undefined);
    const devRegister = await http.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'dev@example.com', password }
    });
    assert.equal(devRegister.status, 201);
    assert.match(devRegister.body.verifyUrl, /\/api\/auth\/verify\?token=/);
  } finally {
    productionEnv();
    await new Promise((resolve) => http.server.close(resolve));
  }
});

test('stale app state writes are rejected and a current write succeeds', async () => {
  productionEnv();
  const app = createApp(pool);
  const http = await listen(app);
  try {
    const email = 'sync@example.com';
    const password = 'password123';
    assert.equal((await http.request('/api/auth/register', { method: 'POST', body: { email, password } })).status, 201);
    const loggedIn = await http.request('/api/auth/login', { method: 'POST', body: { email, password } });
    const cookie = http.cookieFrom(loggedIn);
    const state = { version: 1, todo: [{ id: 't1', title: 'one' }], done: [], ideas: [], feedback: [], projects: ['舟'] };
    const created = await http.request('/api/state', { method: 'PUT', cookie, body: { state, baseUpdatedAt: null } });
    assert.equal(created.status, 200);
    assert.ok(created.body.updatedAt);

    const updated = {
      ...state,
      todo: [{ id: 't1', title: 'two' }]
    };
    const saved = await http.request('/api/state', {
      method: 'PUT',
      cookie,
      body: { state: updated, baseUpdatedAt: created.body.updatedAt }
    });
    assert.equal(saved.status, 200);
    assert.notEqual(saved.body.updatedAt, created.body.updatedAt);

    const stale = await http.request('/api/state', {
      method: 'PUT',
      cookie,
      body: { state, baseUpdatedAt: created.body.updatedAt }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.state.todo[0].title, 'two');
    assert.equal(stale.body.updatedAt, saved.body.updatedAt);
    assertNoAuthMaterial(stale.body);

    const blind = await http.request('/api/state', { method: 'PUT', cookie, body: { state: updated } });
    assert.equal(blind.status, 409);

    const retried = await http.request('/api/state', {
      method: 'PUT',
      cookie,
      body: {
        state: { ...updated, todo: [{ id: 't1', title: 'three' }] },
        baseUpdatedAt: stale.body.updatedAt
      }
    });
    assert.equal(retried.status, 200);
    const loaded = await http.request('/api/state', { cookie });
    assert.equal(loaded.body.state.todo[0].title, 'three');
    assert.equal(loaded.body.updatedAt, retried.body.updatedAt);
  } finally {
    await new Promise((resolve) => http.server.close(resolve));
  }
});

test('an existing unverified account can log in while mail is not configured', async () => {
  productionEnv();
  const app = createApp(pool);
  const http = await listen(app);
  try {
    const email = 'legacy@example.com';
    const password = 'password123';
    const bcrypt = (await import('bcryptjs')).default;
    const passwordHash = await bcrypt.hash(password, 4);
    await pool.execute(
      'INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)',
      ['22222222-2222-4222-8222-222222222222', email, passwordHash]
    );
    const loggedIn = await http.request('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.user.emailVerified, true);
    assertNoAuthMaterial(loggedIn.body);
    const [rows] = await pool.execute('SELECT email_verified_at FROM users WHERE email = ?', [email]);
    assert.ok(rows[0].email_verified_at);
  } finally {
    await new Promise((resolve) => http.server.close(resolve));
  }
});

test('admin account is not created when admin env is missing or incomplete', async () => {
  productionEnv();
  await migrate(pool);
  const [columns] = await pool.execute("SHOW COLUMNS FROM users LIKE 'role'");
  assert.equal(columns.length, 1);
  assert.equal(String(columns[0].Default), 'user');
  assert.equal(columns[0].Null, 'NO');

  await pool.execute("DELETE FROM users WHERE role = 'admin' OR email IN ('admin', 'Admin')");
  assert.equal(await ensureAdminUser(pool), false);
  const [absent] = await pool.execute("SELECT id FROM users WHERE role = 'admin' OR email = 'admin'");
  assert.equal(absent.length, 0);

  process.env.ADMIN_USERNAME = 'admin';
  delete process.env.ADMIN_PASSWORD_HASH;
  await assert.rejects(() => ensureAdminUser(pool), /must both be set/);
  process.env.ADMIN_PASSWORD_HASH = 'not-a-bcrypt-hash';
  await assert.rejects(() => ensureAdminUser(pool), /bcrypt hash/);
  const [stillAbsent] = await pool.execute("SELECT id FROM users WHERE email = 'admin'");
  assert.equal(stillAbsent.length, 0);
  productionEnv();

  const http = await listen(createApp(pool));
  try {
    const rejected = await http.request('/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'password123' } });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, '请填写邮箱和密码');
  } finally {
    productionEnv();
    await new Promise((resolve) => http.server.close(resolve));
  }
});

test('admin username logs in without verification and regular accounts stay the same', async () => {
  productionEnv();
  const bcrypt = (await import('bcryptjs')).default;
  const password = 'adminpass123';
  const passwordHash = await bcrypt.hash(password, 4);
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD_HASH = passwordHash;
  assert.equal(await ensureAdminUser(pool), true);
  assert.equal(await ensureAdminUser(pool), true);

  const [seeded] = await pool.execute(
    'SELECT email, role, email_verified_at, token_version FROM users WHERE email = ?',
    ['admin']
  );
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].role, 'admin');
  assert.ok(seeded[0].email_verified_at);
  assert.equal(Number(seeded[0].token_version), 0);

  process.env.EMAIL_DELIVERY = 'directmail';
  delete process.env.EXPOSE_DEV_LINKS;
  const app = createApp(pool);
  const http = await listen(app);
  try {
    await pool.execute('UPDATE users SET email_verified_at = NULL WHERE email = ?', ['admin']);
    const loggedIn = await http.request('/api/auth/login', { method: 'POST', body: { email: 'admin', password } });
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.user.email, 'admin');
    assert.equal(loggedIn.body.user.role, undefined);
    assertNoAuthMaterial(loggedIn.body);
    const cookie = http.cookieFrom(loggedIn);
    assert.equal(jwt.decode(decodeURIComponent(cookie.split('=')[1])).tv, 0);
    assert.equal((await http.request('/api/auth/me', { cookie })).status, 200);
    const named = await http.request('/api/auth/username', { method: 'POST', cookie, body: { username: '舟主' } });
    assert.equal(named.status, 200);
    assert.equal(named.body.user.username, '舟主');

    const wrongCase = await http.request('/api/auth/login', { method: 'POST', body: { email: 'Admin', password } });
    assert.equal(wrongCase.status, 400);
    const wrongPassword = await http.request('/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'wrong-password' } });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.error, '邮箱或密码不正确');

    for (const email of ['admin', 'Admin', ' admin ']) {
      const reserved = await http.request('/api/auth/register', { method: 'POST', body: { email, password: 'password123' } });
      assert.equal(reserved.status, 400);
      assert.equal(reserved.body.error, '请填写有效的邮箱');
    }
    const [adminRow] = await pool.execute('SELECT password_hash, role FROM users WHERE email = ?', ['admin']);
    assert.equal(adminRow[0].password_hash, passwordHash);
    assert.equal(adminRow[0].role, 'admin');

    const email = 'regular-beside-admin@example.com';
    const userPassword = 'password123';
    const registered = await http.request('/api/auth/register', { method: 'POST', body: { email, password: userPassword } });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.verificationRequired, true);
    assert.equal(registered.body.user.emailVerified, false);
    assertNoAuthMaterial(registered.body);
    const [regular] = await pool.execute('SELECT role, email_verified_at FROM users WHERE email = ?', [email]);
    assert.equal(regular[0].role, 'user');
    assert.equal(regular[0].email_verified_at, null);
    const blocked = await http.request('/api/auth/login', { method: 'POST', body: { email, password: userPassword } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, '请先完成邮箱验证');

    productionEnv();
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD_HASH = passwordHash;
    const openRegister = await http.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'regular-open@example.com', password: userPassword }
    });
    assert.equal(openRegister.status, 201);
    assert.equal(openRegister.body.verificationRequired, false);
    assert.equal(openRegister.body.message, '账号已创建，可以登录');
    const openLogin = await http.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'regular-open@example.com', password: userPassword }
    });
    assert.equal(openLogin.status, 200);
    assert.equal(openLogin.body.user.emailVerified, true);
    const [openRole] = await pool.execute('SELECT role FROM users WHERE email = ?', ['regular-open@example.com']);
    assert.equal(openRole[0].role, 'user');

    const forgotMissing = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email: 'missing@example.com' } });
    const forgotKnown = await http.request('/api/auth/forgot-password', { method: 'POST', body: { email: 'regular-open@example.com' } });
    assert.equal(forgotMissing.status, 503);
    assert.equal(forgotKnown.status, 503);
    assert.equal(forgotKnown.body.error, '找回密码暂不可用，请联系管理员');
    assert.deepEqual(forgotMissing.body, forgotKnown.body);
    assertNoAuthMaterial(forgotKnown.body);
    const [resetRows] = await pool.execute(
      'SELECT id FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ?)',
      ['regular-open@example.com']
    );
    assert.equal(resetRows.length, 0);

    const nextHash = await bcrypt.hash('rotated-admin-pass', 4);
    process.env.ADMIN_PASSWORD_HASH = nextHash;
    assert.equal(await ensureAdminUser(pool), true);
    assert.equal((await http.request('/api/auth/me', { cookie })).status, 401);
    const oldPassword = await http.request('/api/auth/login', { method: 'POST', body: { email: 'admin', password } });
    assert.equal(oldPassword.status, 401);
    const rotated = await http.request('/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'rotated-admin-pass' } });
    assert.equal(rotated.status, 200);
    const [version] = await pool.execute('SELECT token_version, role, email_verified_at FROM users WHERE email = ?', ['admin']);
    assert.equal(Number(version[0].token_version), 1);
    assert.equal(version[0].role, 'admin');
    assert.ok(version[0].email_verified_at);
    assert.equal(jwt.decode(decodeURIComponent(http.cookieFrom(rotated).split('=')[1])).tv, 1);
  } finally {
    productionEnv();
    await new Promise((resolve) => http.server.close(resolve));
  }
});
