#!/usr/bin/env node
// Print a bcrypt hash for ADMIN_PASSWORD_HASH.
// Uses the same algorithm and cost as registration in src/index.js (bcryptjs, 10 rounds).
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

function usage() {
  process.stderr.write(
    'Usage: node scripts/hash-password.js [password]\n' +
    'With no argument, prompts when stdin is a terminal, or reads one line from a pipe.\n' +
    'Prints a bcrypt hash. Put that hash in ADMIN_PASSWORD_HASH. Do not commit it.\n'
  );
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      reject(new Error('no tty'));
      return;
    }
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let value = '';
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stderr.write('\n');
        resolve(value);
        return;
      }
      if (char === '\u0003') {
        process.stdin.setRawMode(false);
        process.exit(1);
      }
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    process.stdin.on('data', onData);
  });
}

async function readPassword() {
  const argument = process.argv[2];
  if (argument !== undefined) {
    if (process.argv.length > 3) {
      usage();
      process.exit(1);
    }
    process.stderr.write('A password argument can remain in shell history. A prompt or pipe is safer.\n');
    return argument;
  }
  if (process.stdin.isTTY) {
    return readHidden('Password: ');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const password = await readPassword();
if (password.length < 8 || password.length > 128) {
  process.stderr.write('Password must be 8 to 128 characters.\n');
  process.exit(1);
}

const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
process.stdout.write(`${hash}\n`);
