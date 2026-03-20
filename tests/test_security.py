"""
Tests for secret encryption helpers.
"""

from __future__ import annotations

import base64

import pytest

from intervals_mcp_server.security import decrypt_secret, encrypt_secret


def test_encrypt_secret_round_trip():
    ciphertext = encrypt_secret("deployment-secret", "intervals-api-key")
    assert decrypt_secret("deployment-secret", ciphertext) == "intervals-api-key"


def test_decrypt_secret_detects_tampering():
    ciphertext = encrypt_secret("deployment-secret", "intervals-api-key")
    payload = bytearray(base64.urlsafe_b64decode(ciphertext.encode("ascii")))
    payload[-1] ^= 0x01
    tampered = base64.urlsafe_b64encode(bytes(payload)).decode("ascii")

    with pytest.raises(ValueError, match="Invalid encrypted secret payload."):
        decrypt_secret("deployment-secret", tampered)


def test_decrypt_secret_rejects_malformed_ciphertext():
    with pytest.raises(ValueError, match="Invalid encrypted secret payload."):
        decrypt_secret("deployment-secret", "not-base64")
