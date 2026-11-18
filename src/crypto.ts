/**
 * Crypsy WebCrypto Engine
 * Provides transparent client-side AES-256-GCM encryption for notes.
 * Cloud / storage layer only ever stores encrypted ciphertext blobs when a vault passphrase is set,
 * or wraps payloads with an auto-generated local key for frictionless default usage.
 */

import type { EncryptedEnvelope, VaultPayload } from './types';
import { APP_VERSION } from './utils';

const PBKDF2_ITERATIONS = 150000;
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

async function deriveKey(passphrase: string, saltBuffer: ArrayBuffer): Promise<CryptoKey> {
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
      iterations: PBKDF2_ITERATIONS,
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
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt.buffer);

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
  const dec = new TextDecoder();
  const saltBuffer = base64ToBuf(envelope.salt);
  const ivBuffer = base64ToBuf(envelope.iv);
  const ciphertextBuffer = base64ToBuf(envelope.ciphertext);

  const key = await deriveKey(passphrase, saltBuffer);
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBuffer) },
    key,
    ciphertextBuffer
  );

  return JSON.parse(dec.decode(plaintextBuffer)) as T;
}

export const CrypsyCrypto = {
  encryptPayload,
  decryptPayload,
};

// Preserve global for incremental migration alongside legacy <script> tags
if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).CrypsyCrypto = CrypsyCrypto;
}
