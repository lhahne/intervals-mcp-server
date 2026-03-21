type Row = Record<string, unknown>;

type Tables = {
  users: Map<string, Row>;
  usersBySubject: Map<string, string>;
  oauth_sessions: Map<string, Row>;
  oauth_clients: Map<string, Row>;
  authorization_codes: Map<string, Row>;
  access_tokens: Map<string, Row>;
  refresh_tokens: Map<string, Row>;
  intervals_credentials: Map<string, Row>;
};

function createTables(): Tables {
  return {
    users: new Map(),
    usersBySubject: new Map(),
    oauth_sessions: new Map(),
    oauth_clients: new Map(),
    authorization_codes: new Map(),
    access_tokens: new Map(),
    refresh_tokens: new Map(),
    intervals_credentials: new Map(),
  };
}

function cloneRow(row: Row | undefined): Row | null {
  return row ? { ...row } : null;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

class MockPreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: MockD1Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run(): Promise<{ success: true }> {
    this.db.execute(this.sql, this.values);
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    return this.db.selectFirst(this.sql, this.values) as T | null;
  }
}

export class MockD1Database {
  readonly tables = createTables();

  prepare(sql: string): MockPreparedStatement {
    return new MockPreparedStatement(this, sql);
  }

  private insertOrReplace(table: keyof Tables, key: string, row: Row): void {
    const target = this.tables[table] as Map<string, Row>;
    target.set(key, row);
  }

  execute(sql: string, values: unknown[]): void {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith("INSERT INTO users")) {
      const [id, googleSubject, email, createdAt, updatedAt] = values;
      const existingId = this.tables.usersBySubject.get(String(googleSubject));
      const userId = existingId ?? String(id);
      const existing = this.tables.users.get(userId);
      const row = {
        id: userId,
        google_subject: String(googleSubject),
        email: email ?? null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      };
      this.tables.users.set(userId, row);
      this.tables.usersBySubject.set(String(googleSubject), userId);
      return;
    }

    if (normalized.startsWith("INSERT INTO oauth_sessions")) {
      const [state, clientId, redirectUri, redirectProvided, codeChallenge, scopesJson, resource, createdAt, expiresAt] = values;
      this.insertOrReplace("oauth_sessions", String(state), {
        state,
        client_id: clientId,
        redirect_uri: redirectUri,
        redirect_uri_provided_explicitly: redirectProvided,
        code_challenge: codeChallenge,
        scopes_json: scopesJson,
        resource,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return;
    }

    if (normalized.startsWith("DELETE FROM oauth_sessions")) {
      this.tables.oauth_sessions.delete(String(values[0]));
      return;
    }

    if (normalized.startsWith("INSERT OR REPLACE INTO oauth_clients")) {
      const [clientId, secret, metadataJson, createdAt] = values;
      this.insertOrReplace("oauth_clients", String(clientId), {
        client_id: clientId,
        client_secret_encrypted: secret,
        metadata_json: metadataJson,
        created_at: createdAt,
      });
      return;
    }

    if (normalized.startsWith("INSERT INTO authorization_codes")) {
      const [code, userId, clientId, scopesJson, redirectUri, redirectProvided, codeChallenge, resource, email, expiresAt] = values;
      this.insertOrReplace("authorization_codes", String(code), {
        code,
        user_id: userId,
        client_id: clientId,
        scopes_json: scopesJson,
        redirect_uri: redirectUri,
        redirect_uri_provided_explicitly: redirectProvided,
        code_challenge: codeChallenge,
        resource,
        email,
        expires_at: expiresAt,
      });
      return;
    }

    if (normalized.startsWith("DELETE FROM authorization_codes")) {
      this.tables.authorization_codes.delete(String(values[0]));
      return;
    }

    if (normalized.startsWith("INSERT OR REPLACE INTO access_tokens")) {
      const [token, userId, clientId, scopesJson, resource, expiresAt] = values;
      this.insertOrReplace("access_tokens", String(token), {
        token,
        user_id: userId,
        client_id: clientId,
        scopes_json: scopesJson,
        resource,
        expires_at: expiresAt,
        revoked_at: null,
      });
      return;
    }

    if (normalized.startsWith("INSERT OR REPLACE INTO refresh_tokens")) {
      const [token, userId, clientId, scopesJson, resource, expiresAt] = values;
      this.insertOrReplace("refresh_tokens", String(token), {
        token,
        user_id: userId,
        client_id: clientId,
        scopes_json: scopesJson,
        resource,
        expires_at: expiresAt,
        revoked_at: null,
      });
      return;
    }

    if (normalized.startsWith("DELETE FROM refresh_tokens")) {
      this.tables.refresh_tokens.delete(String(values[0]));
      return;
    }

    if (normalized.startsWith("UPDATE access_tokens SET revoked_at")) {
      const [token, revokedAt] = values;
      const row = this.tables.access_tokens.get(String(token));
      if (row) {
        row.revoked_at = revokedAt;
      }
      return;
    }

    if (normalized.startsWith("UPDATE refresh_tokens SET revoked_at")) {
      const [token, revokedAt] = values;
      const row = this.tables.refresh_tokens.get(String(token));
      if (row) {
        row.revoked_at = revokedAt;
      }
      return;
    }

    if (normalized.startsWith("INSERT OR REPLACE INTO intervals_credentials")) {
      const [userId, athleteId, encryptedApiKey, updatedAt] = values;
      this.insertOrReplace("intervals_credentials", String(userId), {
        user_id: userId,
        athlete_id: athleteId,
        encrypted_api_key: encryptedApiKey,
        updated_at: updatedAt,
      });
      return;
    }

    if (normalized.startsWith("DELETE FROM intervals_credentials")) {
      this.tables.intervals_credentials.delete(String(values[0]));
      return;
    }

    throw new Error(`Unsupported SQL run(): ${normalized}`);
  }

  selectFirst(sql: string, values: unknown[]): Row | null {
    const normalized = normalizeSql(sql);

    if (normalized === "SELECT * FROM oauth_sessions WHERE state = ?1") {
      return cloneRow(this.tables.oauth_sessions.get(String(values[0])) ?? undefined);
    }
    if (normalized === "SELECT metadata_json, client_secret_encrypted FROM oauth_clients WHERE client_id = ?1") {
      return cloneRow(this.tables.oauth_clients.get(String(values[0])) ?? undefined);
    }
    if (normalized === "SELECT * FROM authorization_codes WHERE code = ?1 AND client_id = ?2") {
      const row = this.tables.authorization_codes.get(String(values[0]));
      return row && row.client_id === values[1] ? cloneRow(row) : null;
    }
    if (normalized === "SELECT at.token, at.user_id, at.client_id, at.scopes_json, at.resource, at.expires_at, u.email, u.google_subject, ic.athlete_id, ic.encrypted_api_key FROM access_tokens at LEFT JOIN users u ON at.user_id = u.id LEFT JOIN intervals_credentials ic ON at.user_id = ic.user_id WHERE at.token = ?1 AND at.revoked_at IS NULL") {
      const tokenRow = this.tables.access_tokens.get(String(values[0]));
      if (!tokenRow || tokenRow.revoked_at !== null) return null;
      const userRow = this.tables.users.get(String(tokenRow.user_id)) ?? {};
      const credRow = this.tables.intervals_credentials.get(String(tokenRow.user_id)) ?? {};
      return {
        token: tokenRow.token,
        user_id: tokenRow.user_id,
        client_id: tokenRow.client_id,
        scopes_json: tokenRow.scopes_json,
        resource: tokenRow.resource,
        expires_at: tokenRow.expires_at,
        email: userRow.email ?? null,
        google_subject: (userRow.google_subject ?? null) as unknown,
        athlete_id: (credRow.athlete_id ?? null) as unknown,
        encrypted_api_key: (credRow.encrypted_api_key ?? null) as unknown,
      } as Row;
    }
    if (normalized === "SELECT token, user_id, client_id, scopes_json, resource, expires_at, revoked_at FROM refresh_tokens WHERE token = ?1 AND client_id = ?2") {
      const row = this.tables.refresh_tokens.get(String(values[0]));
      return row && row.client_id === values[1] ? cloneRow(row) : null;
    }
    if (normalized === "SELECT athlete_id, encrypted_api_key FROM intervals_credentials WHERE user_id = ?1") {
      return cloneRow(this.tables.intervals_credentials.get(String(values[0])) ?? undefined);
    }

    throw new Error(`Unsupported SQL first(): ${normalized}`);
  }
}

