import { randomUUID } from 'node:crypto';

// Same shape bcryptjs produces for account passwords ($2a$/$2b$/$2y$).
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const PLAIN_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function adminUsernameFromEnv() {
  return String(process.env.ADMIN_USERNAME || '').trim();
}

export function adminPasswordHashFromEnv() {
  return String(process.env.ADMIN_PASSWORD_HASH || '').trim();
}

function assertAdminConfig(username, passwordHash) {
  if (!PLAIN_USERNAME.test(username)) {
    throw new Error('ADMIN_USERNAME must be a plain username such as admin, not an email');
  }
  if (!BCRYPT_HASH.test(passwordHash)) {
    throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash from server/scripts/hash-password.js');
  }
}

async function updateAdmin(pool, existing, passwordHash) {
  const sameHash = existing.password_hash === passwordHash;
  const verified = Boolean(existing.email_verified_at);
  if (sameHash && verified && existing.role === 'admin') return;
  await pool.execute(
    `UPDATE users
     SET role = 'admin',
         password_hash = ?,
         email_verified_at = IF(email_verified_at IS NULL, UTC_TIMESTAMP(3), email_verified_at),
         token_version = token_version + ?
     WHERE id = ?`,
    [passwordHash, sameHash ? 0 : 1, existing.id]
  );
}

// Upsert the admin row when both env vars are set. Missing vars leave the
// table unchanged. The login name is stored in users.email; it is not an email.
export async function ensureAdminUser(pool) {
  const username = adminUsernameFromEnv();
  const passwordHash = adminPasswordHashFromEnv();
  if (!username && !passwordHash) return false;
  if (!username || !passwordHash) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD_HASH must both be set');
  }
  assertAdminConfig(username, passwordHash);

  const load = async () => {
    const [rows] = await pool.execute(
      'SELECT id, password_hash, email_verified_at, role FROM users WHERE email = ? LIMIT 1',
      [username]
    );
    return rows[0] || null;
  };

  const existing = await load();
  if (!existing) {
    try {
      await pool.execute(
        `INSERT INTO users (id, email, password_hash, email_verified_at, role)
         VALUES (?, ?, ?, UTC_TIMESTAMP(3), 'admin')`,
        [randomUUID(), username, passwordHash]
      );
      return true;
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  const row = existing || await load();
  if (!row) throw new Error('admin account could not be saved');
  await updateAdmin(pool, row, passwordHash);
  return true;
}
