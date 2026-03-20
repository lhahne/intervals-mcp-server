"""
Persistence layer for OAuth state and per-user Intervals credentials.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from mcp.shared.auth import OAuthClientInformationFull

from intervals_mcp_server.auth_models import (
    IntervalsCredentials,
    ServerAccessToken,
    ServerAuthorizationCode,
    ServerRefreshToken,
)
from intervals_mcp_server.security import decrypt_secret, encrypt_secret


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_subject TEXT NOT NULL UNIQUE,
    email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
    state TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    redirect_uri_provided_explicitly INTEGER NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    resource TEXT,
    google_nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    metadata_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authorization_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    redirect_uri_provided_explicitly INTEGER NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT,
    email TEXT,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS intervals_credentials (
    user_id TEXT PRIMARY KEY,
    athlete_id TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"""


@dataclass(slots=True)
class OAuthSession:
    """Stored state for the Google OAuth handoff."""

    state: str
    client_id: str
    redirect_uri: str
    redirect_uri_provided_explicitly: bool
    code_challenge: str
    scopes: list[str]
    resource: str | None
    google_nonce: str
    expires_at: int


class AuthRepository(Protocol):
    """Persistence protocol for auth state."""

    async def initialize(self) -> None: ...
    async def upsert_user(self, google_subject: str, email: str | None) -> str: ...
    async def create_oauth_session(self, session: OAuthSession) -> None: ...
    async def pop_oauth_session(self, state: str) -> OAuthSession | None: ...
    async def save_client(self, client: OAuthClientInformationFull) -> None: ...
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None: ...
    async def save_authorization_code(self, code: ServerAuthorizationCode) -> None: ...
    async def pop_authorization_code(self, client_id: str, code: str) -> ServerAuthorizationCode | None: ...
    async def save_access_token(self, token: ServerAccessToken) -> None: ...
    async def get_access_token(self, token: str) -> ServerAccessToken | None: ...
    async def save_refresh_token(self, token: ServerRefreshToken) -> None: ...
    async def pop_refresh_token(self, client_id: str, token: str) -> ServerRefreshToken | None: ...
    async def revoke_token(self, token: str) -> None: ...
    async def set_intervals_credentials(self, user_id: str, credentials: IntervalsCredentials) -> None: ...
    async def get_intervals_credentials(self, user_id: str) -> IntervalsCredentials | None: ...
    async def clear_intervals_credentials(self, user_id: str) -> None: ...


class SQLiteAuthRepository:
    """SQLite-backed auth repository used for local dev and tests."""

    def __init__(self, db_path: str, encryption_secret: str):
        self._db_path = db_path
        self._encryption_secret = encryption_secret
        self._connection = sqlite3.connect(db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row

    async def initialize(self) -> None:
        await asyncio.to_thread(self._connection.executescript, SCHEMA_SQL)
        await asyncio.to_thread(self._connection.commit)

    async def upsert_user(self, google_subject: str, email: str | None) -> str:
        now = int(time.time())
        user_id = f"user_{google_subject}"

        def _op() -> str:
            self._connection.execute(
                """
                INSERT INTO users (id, google_subject, email, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(google_subject) DO UPDATE SET
                    email = excluded.email,
                    updated_at = excluded.updated_at
                """,
                (user_id, google_subject, email, now, now),
            )
            self._connection.commit()
            return user_id

        return await asyncio.to_thread(_op)

    async def create_oauth_session(self, session: OAuthSession) -> None:
        await asyncio.to_thread(
            self._connection.execute,
            """
            INSERT INTO oauth_sessions (
                state, client_id, redirect_uri, redirect_uri_provided_explicitly,
                code_challenge, scopes_json, resource, google_nonce, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session.state,
                session.client_id,
                session.redirect_uri,
                int(session.redirect_uri_provided_explicitly),
                session.code_challenge,
                json.dumps(session.scopes),
                session.resource,
                session.google_nonce,
                int(time.time()),
                session.expires_at,
            ),
        )
        await asyncio.to_thread(self._connection.commit)

    async def pop_oauth_session(self, state: str) -> OAuthSession | None:
        def _op() -> OAuthSession | None:
            row = self._connection.execute(
                "SELECT * FROM oauth_sessions WHERE state = ?",
                (state,),
            ).fetchone()
            if row is None:
                return None
            self._connection.execute("DELETE FROM oauth_sessions WHERE state = ?", (state,))
            self._connection.commit()
            if row["expires_at"] < int(time.time()):
                return None
            return OAuthSession(
                state=row["state"],
                client_id=row["client_id"],
                redirect_uri=row["redirect_uri"],
                redirect_uri_provided_explicitly=bool(row["redirect_uri_provided_explicitly"]),
                code_challenge=row["code_challenge"],
                scopes=json.loads(row["scopes_json"]),
                resource=row["resource"],
                google_nonce=row["google_nonce"],
                expires_at=row["expires_at"],
            )

        return await asyncio.to_thread(_op)

    async def save_client(self, client: OAuthClientInformationFull) -> None:
        issued_at = int(time.time())
        metadata_json = client.model_dump_json()
        encrypted_secret = (
            encrypt_secret(self._encryption_secret, client.client_secret) if client.client_secret else None
        )
        await asyncio.to_thread(
            self._connection.execute,
            """
            INSERT OR REPLACE INTO oauth_clients (client_id, client_secret_hash, metadata_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (client.client_id, encrypted_secret, metadata_json, issued_at),
        )
        await asyncio.to_thread(self._connection.commit)

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        def _op() -> OAuthClientInformationFull | None:
            row = self._connection.execute(
                "SELECT metadata_json, client_secret_hash FROM oauth_clients WHERE client_id = ?",
                (client_id,),
            ).fetchone()
            if row is None:
                return None
            data = json.loads(row["metadata_json"])
            data["client_secret"] = (
                decrypt_secret(self._encryption_secret, row["client_secret_hash"]) if row["client_secret_hash"] else None
            )
            client = OAuthClientInformationFull.model_validate(data)
            return client

        return await asyncio.to_thread(_op)

    async def save_authorization_code(self, code: ServerAuthorizationCode) -> None:
        await asyncio.to_thread(
            self._connection.execute,
            """
            INSERT INTO authorization_codes (
                code, user_id, client_id, scopes_json, redirect_uri,
                redirect_uri_provided_explicitly, code_challenge, resource, email, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                code.code,
                code.user_id,
                code.client_id,
                json.dumps(code.scopes),
                str(code.redirect_uri),
                int(code.redirect_uri_provided_explicitly),
                code.code_challenge,
                code.resource,
                code.email,
                int(code.expires_at),
            ),
        )
        await asyncio.to_thread(self._connection.commit)

    async def pop_authorization_code(self, client_id: str, code: str) -> ServerAuthorizationCode | None:
        def _op() -> ServerAuthorizationCode | None:
            row = self._connection.execute(
                "SELECT * FROM authorization_codes WHERE code = ? AND client_id = ?",
                (code, client_id),
            ).fetchone()
            if row is None:
                return None
            self._connection.execute("DELETE FROM authorization_codes WHERE code = ?", (code,))
            self._connection.commit()
            if row["expires_at"] < int(time.time()):
                return None
            return ServerAuthorizationCode(
                code=row["code"],
                user_id=row["user_id"],
                email=row["email"],
                scopes=json.loads(row["scopes_json"]),
                expires_at=float(row["expires_at"]),
                client_id=row["client_id"],
                code_challenge=row["code_challenge"],
                redirect_uri=row["redirect_uri"],
                redirect_uri_provided_explicitly=bool(row["redirect_uri_provided_explicitly"]),
                resource=row["resource"],
            )

        return await asyncio.to_thread(_op)

    async def save_access_token(self, token: ServerAccessToken) -> None:
        await asyncio.to_thread(
            self._connection.execute,
            """
            INSERT OR REPLACE INTO access_tokens (token, user_id, client_id, scopes_json, resource, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                token.token,
                token.user_id,
                token.client_id,
                json.dumps(token.scopes),
                token.resource,
                token.expires_at,
            ),
        )
        await asyncio.to_thread(self._connection.commit)

    async def get_access_token(self, token: str) -> ServerAccessToken | None:
        def _op() -> ServerAccessToken | None:
            row = self._connection.execute(
                """
                SELECT at.*, u.google_subject, u.email, ic.athlete_id, ic.encrypted_api_key
                FROM access_tokens at
                JOIN users u ON u.id = at.user_id
                LEFT JOIN intervals_credentials ic ON ic.user_id = at.user_id
                WHERE at.token = ? AND at.revoked_at IS NULL
                """,
                (token,),
            ).fetchone()
            if row is None or row["expires_at"] < int(time.time()):
                return None
            api_key = (
                decrypt_secret(self._encryption_secret, row["encrypted_api_key"])
                if row["encrypted_api_key"]
                else None
            )
            return ServerAccessToken(
                token=row["token"],
                client_id=row["client_id"],
                scopes=json.loads(row["scopes_json"]),
                expires_at=row["expires_at"],
                resource=row["resource"],
                user_id=row["user_id"],
                google_subject=row["google_subject"],
                email=row["email"],
                intervals_athlete_id=row["athlete_id"],
                intervals_api_key=api_key,
            )

        return await asyncio.to_thread(_op)

    async def save_refresh_token(self, token: ServerRefreshToken) -> None:
        await asyncio.to_thread(
            self._connection.execute,
            """
            INSERT OR REPLACE INTO refresh_tokens (token, user_id, client_id, scopes_json, resource, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                token.token,
                token.user_id,
                token.client_id,
                json.dumps(token.scopes),
                token.resource,
                token.expires_at,
            ),
        )
        await asyncio.to_thread(self._connection.commit)

    async def pop_refresh_token(self, client_id: str, token: str) -> ServerRefreshToken | None:
        def _op() -> ServerRefreshToken | None:
            row = self._connection.execute(
                """
                SELECT * FROM refresh_tokens
                WHERE token = ? AND client_id = ? AND revoked_at IS NULL
                """,
                (token, client_id),
            ).fetchone()
            if row is None:
                return None
            self._connection.execute("UPDATE refresh_tokens SET revoked_at = ? WHERE token = ?", (int(time.time()), token))
            self._connection.commit()
            if row["expires_at"] < int(time.time()):
                return None
            return ServerRefreshToken(
                token=row["token"],
                client_id=row["client_id"],
                scopes=json.loads(row["scopes_json"]),
                expires_at=row["expires_at"],
                user_id=row["user_id"],
                resource=row["resource"],
            )

        return await asyncio.to_thread(_op)

    async def revoke_token(self, token: str) -> None:
        now = int(time.time())
        await asyncio.to_thread(
            self._connection.execute,
            "UPDATE access_tokens SET revoked_at = ? WHERE token = ?",
            (now, token),
        )
        await asyncio.to_thread(
            self._connection.execute,
            "UPDATE refresh_tokens SET revoked_at = ? WHERE token = ?",
            (now, token),
        )
        await asyncio.to_thread(self._connection.commit)

    async def set_intervals_credentials(self, user_id: str, credentials: IntervalsCredentials) -> None:
        encrypted_api_key = encrypt_secret(self._encryption_secret, credentials.api_key)
        await asyncio.to_thread(
            self._connection.execute,
            """
            INSERT OR REPLACE INTO intervals_credentials (user_id, athlete_id, encrypted_api_key, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (user_id, credentials.athlete_id, encrypted_api_key, int(time.time())),
        )
        await asyncio.to_thread(self._connection.commit)

    async def get_intervals_credentials(self, user_id: str) -> IntervalsCredentials | None:
        def _op() -> IntervalsCredentials | None:
            row = self._connection.execute(
                "SELECT athlete_id, encrypted_api_key FROM intervals_credentials WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if row is None:
                return None
            return IntervalsCredentials(
                athlete_id=row["athlete_id"],
                api_key=decrypt_secret(self._encryption_secret, row["encrypted_api_key"]),
            )

        return await asyncio.to_thread(_op)

    async def clear_intervals_credentials(self, user_id: str) -> None:
        await asyncio.to_thread(
            self._connection.execute,
            "DELETE FROM intervals_credentials WHERE user_id = ?",
            (user_id,),
        )
        await asyncio.to_thread(self._connection.commit)


def create_sqlite_repository(db_path: str, encryption_secret: str) -> SQLiteAuthRepository:
    """Create a SQLite repository, ensuring parent directories exist."""
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    return SQLiteAuthRepository(db_path=db_path, encryption_secret=encryption_secret)


class CloudflareD1AuthRepository:
    """Cloudflare D1-backed auth repository for Worker deployments."""

    def __init__(self, database: Any, encryption_secret: str):
        self._database = database
        self._encryption_secret = encryption_secret

    async def initialize(self) -> None:
        await self._database.exec(SCHEMA_SQL)

    async def _run(self, sql: str, *params: Any) -> Any:
        statement = self._database.prepare(sql)
        if params:
            statement = statement.bind(*params)
        return await statement.run()

    async def _fetchone(self, sql: str, *params: Any) -> dict[str, Any] | None:
        result = await self._run(sql, *params)
        rows = _js_to_py(getattr(result, "results", result))
        if not rows:
            return None
        return dict(rows[0])

    async def upsert_user(self, google_subject: str, email: str | None) -> str:
        now = int(time.time())
        user_id = f"user_{google_subject}"
        await self._run(
            """
            INSERT INTO users (id, google_subject, email, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(google_subject) DO UPDATE SET
                email = excluded.email,
                updated_at = excluded.updated_at
            """,
            user_id,
            google_subject,
            email,
            now,
            now,
        )
        return user_id

    async def create_oauth_session(self, session: OAuthSession) -> None:
        await self._run(
            """
            INSERT INTO oauth_sessions (
                state, client_id, redirect_uri, redirect_uri_provided_explicitly,
                code_challenge, scopes_json, resource, google_nonce, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            session.state,
            session.client_id,
            session.redirect_uri,
            int(session.redirect_uri_provided_explicitly),
            session.code_challenge,
            json.dumps(session.scopes),
            session.resource,
            session.google_nonce,
            int(time.time()),
            session.expires_at,
        )

    async def pop_oauth_session(self, state: str) -> OAuthSession | None:
        row = await self._fetchone("SELECT * FROM oauth_sessions WHERE state = ?", state)
        await self._run("DELETE FROM oauth_sessions WHERE state = ?", state)
        if row is None or row["expires_at"] < int(time.time()):
            return None
        return OAuthSession(
            state=row["state"],
            client_id=row["client_id"],
            redirect_uri=row["redirect_uri"],
            redirect_uri_provided_explicitly=bool(row["redirect_uri_provided_explicitly"]),
            code_challenge=row["code_challenge"],
            scopes=json.loads(row["scopes_json"]),
            resource=row["resource"],
            google_nonce=row["google_nonce"],
            expires_at=row["expires_at"],
        )

    async def save_client(self, client: OAuthClientInformationFull) -> None:
        encrypted_secret = (
            encrypt_secret(self._encryption_secret, client.client_secret) if client.client_secret else None
        )
        await self._run(
            """
            INSERT OR REPLACE INTO oauth_clients (client_id, client_secret_hash, metadata_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            client.client_id,
            encrypted_secret,
            client.model_dump_json(),
            int(time.time()),
        )

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        row = await self._fetchone(
            "SELECT metadata_json, client_secret_hash FROM oauth_clients WHERE client_id = ?",
            client_id,
        )
        if row is None:
            return None
        data = json.loads(row["metadata_json"])
        data["client_secret"] = (
            decrypt_secret(self._encryption_secret, row["client_secret_hash"]) if row["client_secret_hash"] else None
        )
        return OAuthClientInformationFull.model_validate(data)

    async def save_authorization_code(self, code: ServerAuthorizationCode) -> None:
        await self._run(
            """
            INSERT INTO authorization_codes (
                code, user_id, client_id, scopes_json, redirect_uri,
                redirect_uri_provided_explicitly, code_challenge, resource, email, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            code.code,
            code.user_id,
            code.client_id,
            json.dumps(code.scopes),
            str(code.redirect_uri),
            int(code.redirect_uri_provided_explicitly),
            code.code_challenge,
            code.resource,
            code.email,
            int(code.expires_at),
        )

    async def pop_authorization_code(self, client_id: str, code: str) -> ServerAuthorizationCode | None:
        row = await self._fetchone(
            "SELECT * FROM authorization_codes WHERE code = ? AND client_id = ?",
            code,
            client_id,
        )
        await self._run("DELETE FROM authorization_codes WHERE code = ?", code)
        if row is None or row["expires_at"] < int(time.time()):
            return None
        return ServerAuthorizationCode(
            code=row["code"],
            user_id=row["user_id"],
            email=row["email"],
            scopes=json.loads(row["scopes_json"]),
            expires_at=float(row["expires_at"]),
            client_id=row["client_id"],
            code_challenge=row["code_challenge"],
            redirect_uri=row["redirect_uri"],
            redirect_uri_provided_explicitly=bool(row["redirect_uri_provided_explicitly"]),
            resource=row["resource"],
        )

    async def save_access_token(self, token: ServerAccessToken) -> None:
        await self._run(
            """
            INSERT OR REPLACE INTO access_tokens (token, user_id, client_id, scopes_json, resource, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            token.token,
            token.user_id,
            token.client_id,
            json.dumps(token.scopes),
            token.resource,
            token.expires_at,
        )

    async def get_access_token(self, token: str) -> ServerAccessToken | None:
        row = await self._fetchone(
            """
            SELECT at.*, u.google_subject, u.email, ic.athlete_id, ic.encrypted_api_key
            FROM access_tokens at
            JOIN users u ON u.id = at.user_id
            LEFT JOIN intervals_credentials ic ON ic.user_id = at.user_id
            WHERE at.token = ? AND at.revoked_at IS NULL
            """,
            token,
        )
        if row is None or row["expires_at"] < int(time.time()):
            return None
        return ServerAccessToken(
            token=row["token"],
            client_id=row["client_id"],
            scopes=json.loads(row["scopes_json"]),
            expires_at=row["expires_at"],
            resource=row["resource"],
            user_id=row["user_id"],
            google_subject=row["google_subject"],
            email=row["email"],
            intervals_athlete_id=row["athlete_id"],
            intervals_api_key=(
                decrypt_secret(self._encryption_secret, row["encrypted_api_key"]) if row["encrypted_api_key"] else None
            ),
        )

    async def save_refresh_token(self, token: ServerRefreshToken) -> None:
        await self._run(
            """
            INSERT OR REPLACE INTO refresh_tokens (token, user_id, client_id, scopes_json, resource, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            token.token,
            token.user_id,
            token.client_id,
            json.dumps(token.scopes),
            token.resource,
            token.expires_at,
        )

    async def pop_refresh_token(self, client_id: str, token: str) -> ServerRefreshToken | None:
        row = await self._fetchone(
            """
            SELECT * FROM refresh_tokens
            WHERE token = ? AND client_id = ? AND revoked_at IS NULL
            """,
            token,
            client_id,
        )
        await self._run("UPDATE refresh_tokens SET revoked_at = ? WHERE token = ?", int(time.time()), token)
        if row is None or row["expires_at"] < int(time.time()):
            return None
        return ServerRefreshToken(
            token=row["token"],
            client_id=row["client_id"],
            scopes=json.loads(row["scopes_json"]),
            expires_at=row["expires_at"],
            user_id=row["user_id"],
            resource=row["resource"],
        )

    async def revoke_token(self, token: str) -> None:
        now = int(time.time())
        await self._run("UPDATE access_tokens SET revoked_at = ? WHERE token = ?", now, token)
        await self._run("UPDATE refresh_tokens SET revoked_at = ? WHERE token = ?", now, token)

    async def set_intervals_credentials(self, user_id: str, credentials: IntervalsCredentials) -> None:
        await self._run(
            """
            INSERT OR REPLACE INTO intervals_credentials (user_id, athlete_id, encrypted_api_key, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            user_id,
            credentials.athlete_id,
            encrypt_secret(self._encryption_secret, credentials.api_key),
            int(time.time()),
        )

    async def get_intervals_credentials(self, user_id: str) -> IntervalsCredentials | None:
        row = await self._fetchone(
            "SELECT athlete_id, encrypted_api_key FROM intervals_credentials WHERE user_id = ?",
            user_id,
        )
        if row is None:
            return None
        return IntervalsCredentials(
            athlete_id=row["athlete_id"],
            api_key=decrypt_secret(self._encryption_secret, row["encrypted_api_key"]),
        )

    async def clear_intervals_credentials(self, user_id: str) -> None:
        await self._run("DELETE FROM intervals_credentials WHERE user_id = ?", user_id)


def _js_to_py(value: Any) -> Any:
    """Convert a Pyodide proxy into a native Python object when possible."""
    if hasattr(value, "to_py"):
        return value.to_py()
    return value
