import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');

export function createPool() {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  const missing = ['DB_HOST', 'DB_USER', 'DB_NAME'].filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing database environment: ${missing.join(', ')}`);
  }
  const pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT || 3306),
    user: DB_USER,
    password: DB_PASSWORD ?? '',
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    timezone: 'Z',
    // Keep DATETIME as strings. mysql2 otherwise parses naive DATETIME in the
    // process timezone and toISOString() labels that shifted value as Z.
    dateStrings: true
  });
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return pool;
}

export function splitSql(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function migrate(pool) {
  const statements = splitSql(readFileSync(schemaPath, 'utf8'));
  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_DUP_KEYNAME') continue;
      throw error;
    }
  }
  // Accounts created before email verification have no pending token. Mark them
  // verified so they can still log in. New unverified users keep a live token.
  await pool.query(`
    UPDATE users AS u
    LEFT JOIN email_verification_tokens AS t
      ON t.user_id = u.id AND t.used_at IS NULL
    SET u.email_verified_at = u.created_at
    WHERE u.email_verified_at IS NULL AND t.id IS NULL
  `);
}

export function utcDateTime(date = new Date()) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export function isoTimestamp(value) {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString() : String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  if (match[4]) {
    const parsed = new Date(text.includes(' ') ? text.replace(' ', 'T') : text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const fraction = (match[3] || '.000').padEnd(4, '0').slice(0, 4);
  return `${match[1]}T${match[2]}${fraction}Z`;
}

export function readJsonColumn(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
