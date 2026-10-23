import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = 'test-secret-value-123456';
process.env.NODE_ENV = 'production';
delete process.env.COOKIE_SECURE;
delete process.env.EXPOSE_DEV_LINKS;
delete process.env.EMAIL_DELIVERY;
delete process.env.ADMIN_USERNAME;
delete process.env.ADMIN_PASSWORD_HASH;

const { createApp } = await import('../src/index.js');

const password = 'password123';
const passwordHash = bcrypt.hashSync(password, 4);

function pool() {
  return {
    async execute(sql) {
      if (String(sql).includes('FROM users')) {
        return [[{
          id: 'user-cookie',
          email: 'cookie@example.com',
          username: null,
          email_verified_at: '2026-01-01 00:00:00.000',
          password_hash: passwordHash,
          token_version: 0,
          role: 'user'
        }]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  };
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    async request(path, { method = 'GET', body, proto } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(proto ? { 'X-Forwarded-Proto': proto } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      await response.text();
      return response;
    }
  };
}

function attributes(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^qingzhou_session=/);
  return cookies[0].split(';').slice(1).map((part) => part.trim());
}

test('session cookie is Secure when X-Forwarded-Proto is https', async () => {
  delete process.env.COOKIE_SECURE;
  const http = await listen(createApp(pool()));
  try {
    const loggedIn = await http.request('/api/auth/login', {
      method: 'POST',
      proto: 'https',
      body: { email: 'cookie@example.com', password }
    });
    assert.equal(loggedIn.status, 200);
    const flags = attributes(loggedIn);
    assert.ok(flags.includes('Secure'));
    assert.ok(flags.includes('HttpOnly'));
    assert.ok(flags.includes('SameSite=Lax'));

    const loggedOut = await http.request('/api/auth/logout', { method: 'POST', proto: 'https' });
    assert.equal(loggedOut.status, 200);
    const cleared = attributes(loggedOut);
    assert.ok(cleared.includes('Secure'));
    assert.ok(cleared.includes('HttpOnly'));
    assert.ok(cleared.includes('SameSite=Lax'));
    assert.ok(cleared.includes('Max-Age=0'));
  } finally {
    http.server.close();
  }
});

test('session cookie stays unsecured for HTTP and for the public IP', async () => {
  delete process.env.COOKIE_SECURE;
  const http = await listen(createApp(pool()));
  try {
    const plain = await http.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'cookie@example.com', password }
    });
    assert.equal(plain.status, 200);
    assert.equal(attributes(plain).includes('Secure'), false);
    assert.ok(attributes(plain).includes('HttpOnly'));
    assert.ok(attributes(plain).includes('SameSite=Lax'));

    const ip = await http.request('/api/auth/login', {
      method: 'POST',
      proto: 'http',
      body: { email: 'cookie@example.com', password }
    });
    assert.equal(ip.status, 200);
    assert.equal(attributes(ip).includes('Secure'), false);

    const loggedOut = await http.request('/api/auth/logout', { method: 'POST', proto: 'http' });
    assert.equal(attributes(loggedOut).includes('Secure'), false);
  } finally {
    http.server.close();
  }
});
