import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import bcrypt from 'bcryptjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hash-password.js');

test('hash-password.js prints a bcrypt hash compatible with login', async () => {
  const password = 'adminpass123';
  const result = spawnSync(process.execPath, [script, password], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const hash = result.stdout.trim();
  assert.match(hash, /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
  assert.equal(result.stdout.includes(password), false);
  assert.equal(await bcrypt.compare(password, hash), true);
  assert.equal(await bcrypt.compare('other-password', hash), false);
});

test('hash-password.js reads stdin and rejects a short password', () => {
  const piped = spawnSync(process.execPath, [script], { encoding: 'utf8', input: 'adminpass123\n' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(piped.stdout.trim(), /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
  assert.equal(piped.stdout.includes('adminpass123'), false);

  const short = spawnSync(process.execPath, [script, 'short'], { encoding: 'utf8' });
  assert.notEqual(short.status, 0);
  assert.equal(short.stdout, '');
  assert.match(short.stderr, /8 to 128/);
});
