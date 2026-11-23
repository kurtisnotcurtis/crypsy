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
const IV_BYTES = 12;

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
  passphrase: string
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
  };
}

export async function decryptPayload<T = VaultPayload>(
  envelope: EncryptedEnvelope,
  passphrase: string
): Promise<T> {
  if (!passphrase) {
    throw new Error('A vault passphrase is required to decrypt data.');
  }
  const dec = new TextDecoder();
  const saltBuffer = base64ToBuf(envelope.salt);
  const ivBuffer = base64ToBuf(envelope.iv);
  const ciphertextBuffer = base64ToBuf(envelope.ciphertext);
  const iterations = resolveEnvelopeIterations(envelope.iterations);

  const key = await deriveKey(passphrase, saltBuffer, iterations);
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBuffer) },
    key,
    ciphertextBuffer
  );

  return JSON.parse(dec.decode(plaintextBuffer)) as T;
}

export function isValidEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.salt === 'string' &&
    obj.salt.length > 0 &&
    typeof obj.iv === 'string' &&
    obj.iv.length > 0 &&
    typeof obj.ciphertext === 'string' &&
    obj.ciphertext.length > 0
  );
}

export const CrypsyCrypto = {
  encryptPayload,
  decryptPayload,
  isValidEncryptedEnvelope,
};
