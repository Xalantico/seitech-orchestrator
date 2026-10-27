-- Sessions gain security metadata; OIDC login transactions (authorization code + PKCE).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'otp';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id_token_hint TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS oidc_transactions (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Password history for the organisation password policy (RNF-27) when Keycloak is not the authority.
CREATE TABLE IF NOT EXISTS password_history (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
