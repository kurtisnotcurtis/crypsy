/**
 * Crypsy WebCrypto Engine
 * Provides client-side AES-256-GCM encryption for notes and boards.
 * Keys are derived strictly from the user-supplied vault passphrase via PBKDF2-SHA256.
 */

import type { EncryptedEnvelope, VaultPayload } from '../types';
import { APP_VERSION } from '../utils';

export const PBKDF2_ITERATIONS = 600000;
const LEGACY_PBKDF2_ITERATIONS = 150000;
const MIN_PBKDF2_ITERATIONS = 10000;
const MAX_PBKDF2_ITERATIONS = 5000000;
export const MIN_PASSPHRASE_LENGTH = 8;
const SALT_BYTES = 16;
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
const IV_BYTES = 12;
const MIN_CIPHERTEXT_BYTES = 16; // AES-GCM 128-bit authentication tag

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
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  try {
    return atob(value).length;
  } catch {
    return null;
  }
}

function resolveEnvelopeIterations(rawIterations: unknown): number {
  if (typeof rawIterations !== 'number' || !Number.isFinite(rawIterations)) {
    return LEGACY_PBKDF2_ITERATIONS;
  }
  const rounded = Math.floor(rawIterations);
  if (rounded < MIN_PBKDF2_ITERATIONS || rounded > MAX_PBKDF2_ITERATIONS) {
    throw new Error('Unsupported PBKDF2 iteration count in vault envelope');
  }
  return rounded;
}

async function deriveKey(
  passphrase: string,
  saltBuffer: ArrayBuffer,
  iterations: number
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptPayload(
  plaintextObj: VaultPayload,
  passphrase: string,
  options: { revision?: number } = {}
): Promise<EncryptedEnvelope> {
  if (!passphrase) {
    throw new Error('A vault passphrase is required to encrypt data.');
  }
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt.buffer, PBKDF2_ITERATIONS);

  const plaintextBytes = enc.encode(JSON.stringify(plaintextObj));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintextBytes
  );

  const revision =
    typeof options.revision === 'number' && Number.isFinite(options.revision) && options.revision > 0
      ? Math.floor(options.revision)
      : undefined;

  return {
    version: 1,
    appVersion: APP_VERSION,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: bufToBase64(salt.buffer),
    iv: bufToBase64(iv.buffer),
    ciphertext: bufToBase64(ciphertextBuffer),
    updatedAt: new Date().toISOString(),
    ...(revision !== undefined ? { revision } : {}),
  };
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
  const dec = new TextDecoder();
  const saltBuffer = base64ToBuf(envelope.salt);
  const ivBuffer = base64ToBuf(envelope.iv);
  const ciphertextBuffer = base64ToBuf(envelope.ciphertext);
  const iterations = resolveEnvelopeIterations(envelope.iterations);

  const key = await deriveKey(passphrase, saltBuffer, iterations);
  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(ivBuffer) },
      key,
      ciphertextBuffer
    );
  } catch {
    throw new VaultDecryptionError();
  }

  return JSON.parse(dec.decode(plaintextBuffer)) as T;
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
    if (typeof obj.version !== 'number' || !Number.isFinite(obj.version) || obj.version < 1) {
      return false;
    }
  }
  if (obj.revision !== undefined) {
    if (typeof obj.revision !== 'number' || !Number.isFinite(obj.revision) || obj.revision < 0) {
      return false;
    }
  }
  return true;
}

export function envelopeFingerprint(envelope: EncryptedEnvelope): string {
  const ct = envelope.ciphertext;
  const head = ct.slice(0, 32);
  const tail = ct.length > 32 ? ct.slice(-32) : '';
  return `${envelope.revision ?? 0}:${envelope.salt}:${envelope.iv}:${ct.length}:${head}:${tail}`;
}
