-- Qingzhou application schema for MySQL 5.7+ / 8.0 (including Alibaba Cloud RDS).
-- Access control is enforced by the API: every query is scoped to the authenticated user id.
--
-- Apply against the application database (DB_NAME). The server runs this file
-- on startup and via `npm run migrate`. Statements are idempotent.

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(64) NULL,
  email_verified_at DATETIME(3) NULL,
  token_version INT NOT NULL DEFAULT 0,
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Existing databases created before username and verification columns.
ALTER TABLE users ADD COLUMN username VARCHAR(64) NULL;
ALTER TABLE users ADD COLUMN email_verified_at DATETIME(3) NULL;
-- Incremented on password reset so previously issued sessions no longer match.
ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0;
-- user (default) or admin. The server upserts the admin row only when
-- ADMIN_USERNAME and ADMIN_PASSWORD_HASH are both set.
ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user';

-- One JSON document per user: { version, todo, done, ideas, feedback, projects, updatedAt }.
-- feedback is [{ text, createdAt }] and must be stored with the rest of the document.
CREATE TABLE IF NOT EXISTS user_app_state (
  user_id CHAR(36) NOT NULL,
  state JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_app_state_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Password-reset and email-verification delivery can be wired to Alibaba DirectMail.
-- Tokens are stored so the mail hook can send the raw token without a schema change.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_reset_token_hash (token_hash),
  KEY idx_password_reset_user (user_id),
  CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_verification_token_hash (token_hash),
  KEY idx_email_verification_user (user_id),
  CONSTRAINT fk_email_verification_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
