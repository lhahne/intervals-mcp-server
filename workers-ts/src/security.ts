async function sha256(secret: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const hash = await sha256(secret);
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlToBytes(encoded: string): Uint8Array {
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export function generateToken(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  const result = new Uint8Array(nonce.length + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), nonce.length);
  return bytesToBase64Url(result);
}

export async function decryptSecret(secret: string, ciphertext: string): Promise<string> {
  const payload = base64UrlToBytes(ciphertext);
  const nonce = payload.slice(0, 12);
  const encrypted = payload.slice(12);
  if (nonce.byteLength !== 12 || encrypted.byteLength === 0) {
    throw new Error("Invalid encrypted secret payload.");
  }
  const key = await aesKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, encrypted);
  return new TextDecoder().decode(plaintext);
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToBase64Url(new Uint8Array(digest));
}
