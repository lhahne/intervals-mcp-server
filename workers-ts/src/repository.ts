import type {
  AccessTokenRecord,
  AuthorizationCodeRecord,
  Env,
  IntervalsCredentials,
  OAuthSession,
  RefreshTokenRecord,
  StoredClient,
} from "./types.js";
import { decryptSecret, encryptSecret } from "./security.js";
import { nowEpochSeconds } from "./utils.js";

type Row = Record<string, unknown>;

function rowToJson<T>(row: Row | null, key: string): T | null {
  if (!row || typeof row[key] !== "string") {
    return null;
  }
  return JSON.parse(row[key] as string) as T;
}

export class D1AuthRepository {
  constructor(private readonly env: Env) {}

  private get db(): D1Database {
    return this.env.DB;
  }

  private get encryptionSecret(): string {
    const value = this.env.MCP_ENCRYPTION_SECRET;
    if (!value) {
      throw new Error("MCP_ENCRYPTION_SECRET is required.");
    }
    return value;
  }

  async upsertUser(googleSubject: string, email?: string | null): Promise<string> {
    const now = nowEpochSeconds();
    const userId = `user_${googleSubject}`;
    await this.db
      .prepare(
        `INSERT INTO users (id, google_subject, email, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(google_subject) DO UPDATE SET
           email = excluded.email,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, googleSubject, email ?? null, now, now)
      .run();
    return userId;
  }

  async createOAuthSession(session: OAuthSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_sessions
         (state, client_id, redirect_uri, redirect_uri_provided_explicitly, code_challenge, scopes_json, resource, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        session.state,
        session.clientId,
        session.redirectUri,
        session.redirectUriProvidedExplicitly ? 1 : 0,
        session.codeChallenge,
        JSON.stringify(session.scopes),
        session.resource ?? null,
        nowEpochSeconds(),
        session.expiresAt,
      )
      .run();
  }

  async popOAuthSession(state: string): Promise<OAuthSession | null> {
    const row = await this.db.prepare("SELECT * FROM oauth_sessions WHERE state = ?1").bind(state).first<Row>();
    if (!row) {
      return null;
    }
    await this.db.prepare("DELETE FROM oauth_sessions WHERE state = ?1").bind(state).run();
    if (Number(row.expires_at) < nowEpochSeconds()) {
      return null;
    }
    return {
      state: String(row.state),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      redirectUriProvidedExplicitly: Boolean(row.redirect_uri_provided_explicitly),
      codeChallenge: String(row.code_challenge),
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      resource: row.resource ? String(row.resource) : null,
      expiresAt: Number(row.expires_at),
    };
  }

  async saveClient(client: StoredClient): Promise<void> {
    const encryptedSecret = client.client_secret
      ? await encryptSecret(this.encryptionSecret, client.client_secret)
      : null;
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO oauth_clients
         (client_id, client_secret_encrypted, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(client.client_id, encryptedSecret, JSON.stringify(client), nowEpochSeconds())
      .run();
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    const row = await this.db
      .prepare("SELECT metadata_json, client_secret_encrypted FROM oauth_clients WHERE client_id = ?1")
      .bind(clientId)
      .first<Row>();
    const client = rowToJson<StoredClient>(row, "metadata_json");
    if (!client) {
      return null;
    }
    if (typeof row?.client_secret_encrypted === "string") {
      client.client_secret = await decryptSecret(this.encryptionSecret, row.client_secret_encrypted);
    }
    return client;
  }

  async saveAuthorizationCode(code: AuthorizationCodeRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO authorization_codes
         (code, user_id, client_id, scopes_json, redirect_uri, redirect_uri_provided_explicitly, code_challenge, resource, email, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        code.code,
        code.userId,
        code.clientId,
        JSON.stringify(code.scopes),
        code.redirectUri,
        code.redirectUriProvidedExplicitly ? 1 : 0,
        code.codeChallenge,
        code.resource ?? null,
        code.email ?? null,
        code.expiresAt,
      )
      .run();
  }

  async popAuthorizationCode(clientId: string, code: string): Promise<AuthorizationCodeRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM authorization_codes WHERE code = ?1 AND client_id = ?2")
      .bind(code, clientId)
      .first<Row>();
    if (!row) {
      return null;
    }
    await this.db.prepare("DELETE FROM authorization_codes WHERE code = ?1").bind(code).run();
    if (Number(row.expires_at) < nowEpochSeconds()) {
      return null;
    }
    return {
      code: String(row.code),
      userId: String(row.user_id),
      email: row.email ? String(row.email) : null,
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      expiresAt: Number(row.expires_at),
      clientId: String(row.client_id),
      codeChallenge: String(row.code_challenge),
      redirectUri: String(row.redirect_uri),
      redirectUriProvidedExplicitly: Boolean(row.redirect_uri_provided_explicitly),
      resource: row.resource ? String(row.resource) : null,
    };
  }

  async saveAccessToken(token: AccessTokenRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO access_tokens
         (token, user_id, client_id, scopes_json, resource, expires_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`,
      )
      .bind(token.token, token.userId, token.clientId, JSON.stringify(token.scopes), token.resource ?? null, token.expiresAt)
      .run();
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT at.token, at.user_id, at.client_id, at.scopes_json, at.resource, at.expires_at,
                u.email, u.google_subject, ic.athlete_id, ic.encrypted_api_key
         FROM access_tokens at
         LEFT JOIN users u ON at.user_id = u.id
         LEFT JOIN intervals_credentials ic ON at.user_id = ic.user_id
         WHERE at.token = ?1 AND at.revoked_at IS NULL`,
      )
      .bind(token)
      .first<Row>();
    if (!row || Number(row.expires_at) < nowEpochSeconds()) {
      return null;
    }
    const scopes = JSON.parse(String(row.scopes_json)) as string[];
    const decryptedApiKey = row.encrypted_api_key
      ? await decryptSecret(this.encryptionSecret, String(row.encrypted_api_key))
      : null;
    return {
      token: String(row.token),
      userId: String(row.user_id),
      clientId: String(row.client_id),
      scopes,
      resource: row.resource ? String(row.resource) : null,
      expiresAt: Number(row.expires_at),
      email: row.email ? String(row.email) : null,
      googleSubject: row.google_subject ? String(row.google_subject) : null,
      intervalsAthleteId: row.athlete_id ? String(row.athlete_id) : null,
      intervalsApiKey: decryptedApiKey,
    };
  }

  async saveRefreshToken(token: RefreshTokenRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO refresh_tokens
         (token, user_id, client_id, scopes_json, resource, expires_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`,
      )
      .bind(token.token, token.userId, token.clientId, JSON.stringify(token.scopes), token.resource ?? null, token.expiresAt)
      .run();
  }

  async popRefreshToken(clientId: string, token: string): Promise<RefreshTokenRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT token, user_id, client_id, scopes_json, resource, expires_at, revoked_at FROM refresh_tokens WHERE token = ?1 AND client_id = ?2",
      )
      .bind(token, clientId)
      .first<Row>();
    if (!row || row.revoked_at) {
      return null;
    }
    await this.db.prepare("DELETE FROM refresh_tokens WHERE token = ?1").bind(token).run();
    if (Number(row.expires_at) < nowEpochSeconds()) {
      return null;
    }
    const scopes = JSON.parse(String(row.scopes_json)) as string[];
    return {
      token: String(row.token),
      userId: String(row.user_id),
      clientId: String(row.client_id),
      scopes,
      resource: row.resource ? String(row.resource) : null,
      expiresAt: Number(row.expires_at),
    };
  }

  async revokeToken(token: string): Promise<void> {
    const now = nowEpochSeconds();
    await Promise.all([
      this.db.prepare("UPDATE access_tokens SET revoked_at = ?2 WHERE token = ?1").bind(token, now).run(),
      this.db.prepare("UPDATE refresh_tokens SET revoked_at = ?2 WHERE token = ?1").bind(token, now).run(),
    ]);
  }

  async setIntervalsCredentials(userId: string, credentials: IntervalsCredentials): Promise<void> {
    const encryptedApiKey = await encryptSecret(this.encryptionSecret, credentials.apiKey);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO intervals_credentials
         (user_id, athlete_id, encrypted_api_key, updated_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(userId, credentials.athleteId, encryptedApiKey, nowEpochSeconds())
      .run();
  }

  async getIntervalsCredentials(userId: string): Promise<IntervalsCredentials | null> {
    const row = await this.db
      .prepare("SELECT athlete_id, encrypted_api_key FROM intervals_credentials WHERE user_id = ?1")
      .bind(userId)
      .first<Row>();
    if (!row || typeof row.athlete_id !== "string" || typeof row.encrypted_api_key !== "string") {
      return null;
    }
    return {
      athleteId: row.athlete_id,
      apiKey: await decryptSecret(this.encryptionSecret, row.encrypted_api_key),
    };
  }

  async clearIntervalsCredentials(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM intervals_credentials WHERE user_id = ?1").bind(userId).run();
  }
}
