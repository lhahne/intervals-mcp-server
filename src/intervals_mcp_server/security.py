"""
Security helpers for secrets and token generation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def generate_token(length: int = 32) -> str:
    """Generate a URL-safe random token."""
    return secrets.token_urlsafe(length)

def constant_time_equals(left: str, right: str) -> bool:
    """Compare two strings using constant-time semantics."""
    return hmac.compare_digest(left, right)


def _derive_key(secret: str) -> bytes:
    """Derive a fixed-size AES key from the deployment secret."""
    return hashlib.sha256(secret.encode("utf-8")).digest()


def encrypt_secret(secret: str, plaintext: str) -> str:
    """Encrypt a secret for storage using AES-GCM."""
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(_derive_key(secret)).encrypt(nonce, plaintext.encode("utf-8"), None)
    return base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def decrypt_secret(secret: str, ciphertext: str) -> str:
    """Decrypt a stored secret."""
    try:
        blob = base64.urlsafe_b64decode(ciphertext.encode("ascii"))
        nonce = blob[:12]
        encrypted = blob[12:]
        if len(nonce) != 12 or not encrypted:
            raise ValueError("Invalid encrypted secret payload.")
        payload = AESGCM(_derive_key(secret)).decrypt(nonce, encrypted, None)
        return payload.decode("utf-8")
    except (ValueError, InvalidTag, UnicodeDecodeError) as exc:
        raise ValueError("Invalid encrypted secret payload.") from exc
