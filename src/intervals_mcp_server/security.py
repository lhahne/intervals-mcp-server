"""
Security helpers for secrets and token generation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets


def generate_token(length: int = 32) -> str:
    """Generate a URL-safe random token."""
    return secrets.token_urlsafe(length)


def hash_client_secret(secret: str) -> str:
    """Hash a client secret for storage."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def constant_time_equals(left: str, right: str) -> bool:
    """Compare two strings using constant-time semantics."""
    return hmac.compare_digest(left, right)


def _keystream(secret: str, nonce: bytes, length: int) -> bytes:
    material = secret.encode("utf-8")
    stream = bytearray()
    counter = 0
    while len(stream) < length:
        block = hashlib.sha256(material + nonce + counter.to_bytes(4, "big")).digest()
        stream.extend(block)
        counter += 1
    return bytes(stream[:length])


def encrypt_secret(secret: str, plaintext: str) -> str:
    """
    Encrypt a secret for storage.

    This uses a deterministic keystream derived from SHA-256 plus an HMAC tag.
    It avoids external crypto dependencies, but still provides authenticated
    confidentiality when the deployment secret remains private.
    """
    nonce = secrets.token_bytes(16)
    payload = plaintext.encode("utf-8")
    cipher = bytes(a ^ b for a, b in zip(payload, _keystream(secret, nonce, len(payload)), strict=False))
    tag = hmac.new(secret.encode("utf-8"), nonce + cipher, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(nonce + tag + cipher).decode("ascii")


def decrypt_secret(secret: str, ciphertext: str) -> str:
    """Decrypt a stored secret."""
    blob = base64.urlsafe_b64decode(ciphertext.encode("ascii"))
    nonce = blob[:16]
    tag = blob[16:48]
    cipher = blob[48:]
    expected_tag = hmac.new(secret.encode("utf-8"), nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expected_tag):
        raise ValueError("Encrypted secret integrity check failed.")
    payload = bytes(a ^ b for a, b in zip(cipher, _keystream(secret, nonce, len(cipher)), strict=False))
    return payload.decode("utf-8")
