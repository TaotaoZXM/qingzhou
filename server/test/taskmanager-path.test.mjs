import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

process.env.SERVE_STATIC = '1';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-value-123456';

const { createApp } = await import('../src/index.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function listen(app) {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(server, path, { method = 'GET', redirect = 'manual' } = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect });
  const body = await response.text();
  return { response, body };
}

test('preview heading is gone from the shell', () => {
  assert.equal(html.includes('手机网页版预览'), false);
  assert.equal(html.includes('v31'), false);
  assert.equal(html.includes('class="heading"'), false);
  assert.equal(html.includes('.heading'), false);
  assert.match(html, /<base href="\/taskmanager\/">/);
  assert.match(html, /myqingzhou\.com/);
});

test('static server publishes the same shell at /taskmanager', async () => {
  const server = await listen(createApp({}));
  try {
    const slash = await request(server, '/taskmanager');
    assert.equal(slash.response.status, 301);
    assert.equal(slash.response.headers.get('location'), '/taskmanager/');

    const login = await request(server, '/taskmanager?login=1');
    assert.equal(login.response.status, 301);
    assert.equal(login.response.headers.get('location'), '/taskmanager/?login=1');

    const app = await request(server, '/taskmanager/');
    assert.equal(app.response.status, 200);
    assert.match(app.response.headers.get('content-type'), /text\/html/);
    assert.match(app.body, /轻舟/);
    assert.equal(app.body.includes('手机网页版预览'), false);

    const deep = await request(server, '/taskmanager/cal/today');
    assert.equal(deep.response.status, 200);
    assert.match(deep.body, /<div class="phone">/);

    const manifest = await request(server, '/taskmanager/manifest.json');
    assert.equal(manifest.response.status, 200);
    assert.match(manifest.body, /"start_url": "\.\/"/);

    const worker = await request(server, '/taskmanager/sw.js');
    assert.equal(worker.response.status, 200);
    assert.match(worker.body, /\/api\//);

    const rootPage = await request(server, '/?login=1');
    assert.equal(rootPage.response.status, 200);
    assert.match(rootPage.body, /<div class="phone">/);

    const secret = await request(server, '/taskmanager/server/src/index.js');
    assert.equal(secret.response.status, 404);
    const rootSecret = await request(server, '/server/src/index.js');
    assert.equal(rootSecret.response.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
