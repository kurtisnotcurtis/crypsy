/**
 * Crypsy WebCrypto Engine
 * Provides client-side AES-256-GCM encryption for notes and boards.
 * Keys are derived strictly from the user-supplied vault passphrase via PBKDF2-SHA256.
 *
 * Envelope v2 binds security-critical header metadata (version, cipher, KDF,
 * iterations, salt, iv, revision) into the AES-GCM authentication tag via AAD,
 * while retaining read compatibility with v1 envelopes.
 *
 * Unlocked sessions retain non-extractable WebCrypto `CryptoKey` handles instead
 * of the plaintext passphrase string, avoiding repeated PBKDF2 work on every save
 * while still generating a fresh 96-bit IV per save and fresh salt on re-key/setup.
 */

import type { EncryptedEnvelope, VaultPayload, VaultSessionKey } from '../types';
import { APP_VERSION } from '../utils';

export const PBKDF2_ITERATIONS = 600000;
const LEGACY_PBKDF2_ITERATIONS = 150000;
const MIN_PBKDF2_ITERATIONS = 10000;
const MAX_PBKDF2_ITERATIONS = 5000000;
export const MIN_PASSPHRASE_LENGTH = 12;
export const CURRENT_ENVELOPE_VERSION = 2;
const SALT_BYTES = 16;
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
const IV_BYTES = 12;
const MIN_CIPHERTEXT_BYTES = 16; // AES-GCM 128-bit authentication tag

interface WebCryptoSessionHandle {
  kind: 'webcrypto';
  aesKey: CryptoKey;
  pbkdf2BaseKey: CryptoKey;
}

export class VaultDecryptionError extends Error {
  constructor(message = 'Incorrect passphrase — AES-GCM authentication tag verification failed.') {
    super(message);
    this.name = 'VaultDecryptionError';
  }
}

function bufToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBuf(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function tryDecodeBase64Length(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - pad;
  return decodedBytes >= 0 ? decodedBytes : null;
}

export function resolveEnvelopeIterations(rawIterations: unknown): number {
  if (typeof rawIterations !== 'number' || !Number.isFinite(rawIterations)) {
    return LEGACY_PBKDF2_ITERATIONS;
  }
  const rounded = Math.floor(rawIterations);
  if (rounded < MIN_PBKDF2_ITERATIONS || rounded > MAX_PBKDF2_ITERATIONS) {
    throw new Error('Unsupported PBKDF2 iteration count in vault envelope');
  }
  return rounded;
}

function encodeEnvelopeAad(fields: {
  version: number;
  cipher: string;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
  revision: number;
}): ArrayBuffer {
  const canonical = `crypsy:v${fields.version}|cipher=${fields.cipher}|kdf=${fields.kdf}|iter=${fields.iterations}|salt=${fields.salt}|iv=${fields.iv}|rev=${fields.revision}`;
  const encoded = new TextEncoder().encode(canonical);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out.buffer;
}

async function importPbkdf2BaseKey(passphrase: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
}

async function deriveAesKeyFromBase(
  baseKey: CryptoKey,
  saltBuffer: ArrayBuffer,
  iterations: number
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveKey(
  passphrase: string,
  saltBuffer: ArrayBuffer,
  iterations: number
): Promise<CryptoKey> {
  const keyMaterial = await importPbkdf2BaseKey(passphrase);
  return deriveAesKeyFromBase(keyMaterial, saltBuffer, iterations);
}

function getWebCryptoHandle(sessionKey: VaultSessionKey): WebCryptoSessionHandle {
  const handle = sessionKey._handle as Partial<WebCryptoSessionHandle> | null;
  if (!handle || handle.kind !== 'webcrypto' || !handle.aesKey || !handle.pbkdf2BaseKey) {
    throw new Error('Invalid WebCrypto session key handle.');
  }
  return handle as WebCryptoSessionHandle;
}

async function encryptWithAesKey(
  plaintextObj: VaultPayload,
  aesKey: CryptoKey,
  saltB64: string,
  iterations: number,
  options: { revision?: number } = {}
): Promise<EncryptedEnvelope> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ivB64 = bufToBase64(iv.buffer);

  const revision =
    typeof options.revision === 'number' && Number.isFinite(options.revision) && options.revision > 0
      ? Math.floor(options.revision)
      : undefined;

  const additionalData = encodeEnvelopeAad({
    version: CURRENT_ENVELOPE_VERSION,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: saltB64,
    iv: ivB64,
    revision: revision ?? 0,
  });

  const plaintextBytes = enc.encode(JSON.stringify(plaintextObj));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    aesKey,
    plaintextBytes
  );

  return {
    version: CURRENT_ENVELOPE_VERSION,
    appVersion: APP_VERSION,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: saltB64,
    iv: ivB64,
    ciphertext: bufToBase64(ciphertextBuffer),
    updatedAt: new Date().toISOString(),
    ...(revision !== undefined ? { revision } : {}),
  };
}

async function decryptWithAesKey<T = VaultPayload>(
  envelope: EncryptedEnvelope,
  aesKey: CryptoKey,
  iterations: number
): Promise<T> {
  const dec = new TextDecoder();
  const ivBuffer = base64ToBuf(envelope.iv);
  const ciphertextBuffer = base64ToBuf(envelope.ciphertext);
  const envelopeVersion =
    typeof envelope.version === 'number' && Number.isFinite(envelope.version)
      ? Math.floor(envelope.version)
      : 1;

  const aesParams: AesGcmParams = {
    name: 'AES-GCM',
    iv: new Uint8Array(ivBuffer),
  };

  if (envelopeVersion >= 2) {
    aesParams.additionalData = encodeEnvelopeAad({
      version: envelopeVersion,
      cipher: envelope.cipher ?? 'AES-256-GCM',
      kdf: envelope.kdf ?? 'PBKDF2-SHA256',
      iterations,
      salt: envelope.salt,
      iv: envelope.iv,
      revision:
        typeof envelope.revision === 'number' && Number.isFinite(envelope.revision)
          ? Math.floor(envelope.revision)
          : 0,
    });
  }

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await crypto.subtle.decrypt(aesParams, aesKey, ciphertextBuffer);
  } catch {
    throw new VaultDecryptionError();
  }

  return JSON.parse(dec.decode(plaintextBuffer)) as T;
}

/**
 * Derives a fresh non-extractable session key (new 16-byte salt, 600,000 PBKDF2 iterations).
 * Used on vault creation, legacy upgrade, and passphrase re-keying.
 */
export async function createSessionKey(passphrase: string): Promise<VaultSessionKey> {
  if (!passphrase) {
    throw new Error('A vault passphrase is required to derive a session key.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const pbkdf2BaseKey = await importPbkdf2BaseKey(passphrase);
  const aesKey = await deriveAesKeyFromBase(pbkdf2BaseKey, salt.buffer, PBKDF2_ITERATIONS);
  return {
    salt: bufToBase64(salt.buffer),
    iterations: PBKDF2_ITERATIONS,
    _handle: {
      kind: 'webcrypto',
      aesKey,
      pbkdf2BaseKey,
    } satisfies WebCryptoSessionHandle,
  };
}

/**
 * Unlocks an envelope with a user passphrase and returns both the decrypted payload
 * and a non-extractable `VaultSessionKey` (upgrading legacy <600k iteration sessions
 * to a fresh 600k-iteration save key automatically).
 */
export async function unlockEnvelopeWithPassphrase<T = VaultPayload>(
  envelope: EncryptedEnvelope,
  passphrase: string
): Promise<{ payload: T; sessionKey: VaultSessionKey }> {
  if (!passphrase) {
    throw new Error('A vault passphrase is required to decrypt data.');
  }
  if (!isValidEncryptedEnvelope(envelope)) {
    throw new Error('Invalid encrypted vault envelope.');
  }
  const saltBuffer = base64ToBuf(envelope.salt);
  const iterations = resolveEnvelopeIterations(envelope.iterations);
  const pbkdf2BaseKey = await importPbkdf2BaseKey(passphrase);
  const envelopeAesKey = await deriveAesKeyFromBase(pbkdf2BaseKey, saltBuffer, iterations);
  const payload = await decryptWithAesKey<T>(envelope, envelopeAesKey, iterations);

  if (iterations >= PBKDF2_ITERATIONS) {
    return {
      payload,
      sessionKey: {
        salt: envelope.salt,
        iterations,
        _handle: {
          kind: 'webcrypto',
          aesKey: envelopeAesKey,
          pbkdf2BaseKey,
        } satisfies WebCryptoSessionHandle,
      },
    };
  }

  // Upgrade low-iteration (legacy 150k) session key to 600k iterations with a fresh salt for future saves
  const nextSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nextAesKey = await deriveAesKeyFromBase(pbkdf2BaseKey, nextSalt.buffer, PBKDF2_ITERATIONS);
  return {
    payload,
    sessionKey: {
      salt: bufToBase64(nextSalt.buffer),
      iterations: PBKDF2_ITERATIONS,
      _handle: {
        kind: 'webcrypto',
        aesKey: nextAesKey,
        pbkdf2BaseKey,
      } satisfies WebCryptoSessionHandle,
    },
  };
}

/**
 * Encrypts a payload using an active non-extractable `VaultSessionKey` (fresh 96-bit IV per save,
 * zero PBKDF2 re-derivation cost, v2 authenticated envelope metadata).
 */
export async function encryptPayloadWithSessionKey(
  plaintextObj: VaultPayload,
  sessionKey: VaultSessionKey,
  options: { revision?: number } = {}
): Promise<EncryptedEnvelope> {
  const handle = getWebCryptoHandle(sessionKey);
  return encryptWithAesKey(
    plaintextObj,
    handle.aesKey,
    sessionKey.salt,
    sessionKey.iterations,
    options
  );
}

/**
 * Decrypts an envelope (e.g., remote cloud sync update) using an active non-extractable
 * `VaultSessionKey`. Uses the cached AES key directly when salt/iterations match, or derives
 * the remote envelope's AES key from the non-extractable PBKDF2 base key when salt differs.
 */
export async function decryptPayloadWithSessionKey<T = VaultPayload>(
  envelope: EncryptedEnvelope,
  sessionKey: VaultSessionKey
): Promise<T> {
  if (!isValidEncryptedEnvelope(envelope)) {
    throw new Error('Invalid encrypted vault envelope.');
  }
  const handle = getWebCryptoHandle(sessionKey);
  const iterations = resolveEnvelopeIterations(envelope.iterations);
  if (envelope.salt === sessionKey.salt && iterations === sessionKey.iterations) {
    return decryptWithAesKey<T>(envelope, handle.aesKey, iterations);
  }
  const remoteAesKey = await deriveAesKeyFromBase(
    handle.pbkdf2BaseKey,
    base64ToBuf(envelope.salt),
    iterations
  );
  return decryptWithAesKey<T>(envelope, remoteAesKey, iterations);
}

/**
 * Verifies a user-entered current passphrase against an active non-extractable `VaultSessionKey`
 * without storing any plaintext passphrase or password hash in memory.
 */
export async function verifySessionKeyPassphrase(
  sessionKey: VaultSessionKey,
  candidatePassphrase: string
): Promise<boolean> {
  if (!candidatePassphrase) return false;
  const handle = getWebCryptoHandle(sessionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const challenge = crypto.getRandomValues(new Uint8Array(16));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, handle.aesKey, challenge);
  const candidateKey = await deriveKey(
    candidatePassphrase,
    base64ToBuf(sessionKey.salt),
    sessionKey.iterations
  );
  try {
    const decrypted = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, candidateKey, encrypted)
    );
    if (decrypted.length !== challenge.length) return false;
    let diff = 0;
    for (let i = 0; i < challenge.length; i++) {
      diff |= decrypted[i]! ^ challenge[i]!;
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export async function encryptPayload(
  plaintextObj: VaultPayload,
  passphrase: string,
  options: { revision?: number } = {}
): Promise<EncryptedEnvelope> {
  if (!passphrase) {
    throw new Error('A vault passphrase is required to encrypt data.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt.buffer, PBKDF2_ITERATIONS);
  return encryptWithAesKey(plaintextObj, key, bufToBase64(salt.buffer), PBKDF2_ITERATIONS, options);
}

export async function decryptPayload<T = VaultPayload>(
  envelope: EncryptedEnvelope,
  passphrase: string
): Promise<T> {
  if (!passphrase) {
    throw new Error('A vault passphrase is required to decrypt data.');
  }
  if (!isValidEncryptedEnvelope(envelope)) {
    throw new Error('Invalid encrypted vault envelope.');
  }
  const saltBuffer = base64ToBuf(envelope.salt);
  const iterations = resolveEnvelopeIterations(envelope.iterations);
  const key = await deriveKey(passphrase, saltBuffer, iterations);
  return decryptWithAesKey<T>(envelope, key, iterations);
}

export function isValidEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;

  const saltLen = tryDecodeBase64Length(obj.salt);
  if (saltLen === null || saltLen < MIN_SALT_BYTES || saltLen > MAX_SALT_BYTES) return false;

  const ivLen = tryDecodeBase64Length(obj.iv);
  if (ivLen !== IV_BYTES) return false;

  const ctLen = tryDecodeBase64Length(obj.ciphertext);
  if (ctLen === null || ctLen < MIN_CIPHERTEXT_BYTES) return false;

  if (obj.cipher !== undefined && obj.cipher !== 'AES-256-GCM') return false;
  if (obj.kdf !== undefined && obj.kdf !== 'PBKDF2-SHA256') return false;
  if (obj.iterations !== undefined) {
    if (
      typeof obj.iterations !== 'number' ||
      !Number.isFinite(obj.iterations) ||
      Math.floor(obj.iterations) < MIN_PBKDF2_ITERATIONS ||
      Math.floor(obj.iterations) > MAX_PBKDF2_ITERATIONS
    ) {
      return false;
    }
  }
  if (obj.version !== undefined) {
    if (
      typeof obj.version !== 'number' ||
      !Number.isFinite(obj.version) ||
      !Number.isInteger(obj.version) ||
      obj.version < 1 ||
      obj.version > CURRENT_ENVELOPE_VERSION
    ) {
      return false;
    }
  }
  if (obj.revision !== undefined) {
    if (
      typeof obj.revision !== 'number' ||
      !Number.isFinite(obj.revision) ||
      !Number.isInteger(obj.revision) ||
      obj.revision < 0
    ) {
      return false;
    }
  }
  return true;
}

export function envelopeFingerprint(envelope: EncryptedEnvelope): string {
  const ct = envelope.ciphertext;
  const head = ct.slice(0, 32);
  const tail = ct.length > 32 ? ct.slice(-32) : '';
  return `${envelope.version ?? 1}:${envelope.revision ?? 0}:${envelope.salt}:${envelope.iv}:${ct.length}:${head}:${tail}`;
}
