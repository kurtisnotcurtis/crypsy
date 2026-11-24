import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CURRENT_ENVELOPE_VERSION,
  PBKDF2_ITERATIONS,
  VaultDecryptionError,
  createSessionKey,
  decryptPayload,
  decryptPayloadWithSessionKey,
  encryptPayload,
  encryptPayloadWithSessionKey,
  isValidEncryptedEnvelope,
  unlockEnvelopeWithPassphrase,
  verifySessionKeyPassphrase,
} from '../src/vault/crypto';
import type { EncryptedEnvelope, VaultPayload } from '../src/types';

async function createLegacyV1Envelope(
  payload: VaultPayload,
  passphrase: string,
  iterations = 150000
): Promise<EncryptedEnvelope> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  // v1 did NOT pass additionalData
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(payload))
  );
  return {
    version: 1,
    appVersion: '1.7.0',
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ct).toString('base64'),
    updatedAt: new Date().toISOString(),
    revision: 2,
  };
}

describe('crypto', () => {
  it('round-trips a vault payload with AES-256-GCM v2 AAD and revision metadata', async () => {
    const payload: VaultPayload = {
      notes: [
        {
          id: 'n1',
          title: 'Secret',
          description: 'Top secret body',
          tags: ['security'],
          pinned: true,
          color: 'teal',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
      tags: ['security'],
      boards: [],
    };
    const envelope = await encryptPayload(payload, 'correct-horse-battery', { revision: 3 });
    assert.equal(envelope.version, CURRENT_ENVELOPE_VERSION);
    assert.equal(envelope.cipher, 'AES-256-GCM');
    assert.equal(envelope.kdf, 'PBKDF2-SHA256');
    assert.equal(envelope.iterations, PBKDF2_ITERATIONS);
    assert.equal(envelope.revision, 3);
    assert.equal(isValidEncryptedEnvelope(envelope), true);

    const decrypted = await decryptPayload(envelope, 'correct-horse-battery');
    assert.deepEqual(decrypted, payload);
  });

  it('authenticates revision and version metadata via AES-GCM AAD (H2)', async () => {
    const envelope = await encryptPayload(
      { notes: [], tags: ['aad'], boards: [] },
      'correct-horse-battery',
      { revision: 5 }
    );
    // Tampering with revision MUST fail AES-GCM authentication
    await assert.rejects(
      () => decryptPayload({ ...envelope, revision: 99 }, 'correct-horse-battery'),
      (err) => err instanceof VaultDecryptionError
    );
    // Stripping version 2 -> version 1 MUST ALSO fail AES-GCM authentication
    await assert.rejects(
      () => decryptPayload({ ...envelope, version: 1 }, 'correct-horse-battery'),
      (err) => err instanceof VaultDecryptionError
    );
  });

  it('remains backward-compatible with legacy v1 envelopes and upgrades 150k session keys', async () => {
    const payload: VaultPayload = { notes: [], tags: ['legacy-v1'], boards: [] };
    const v1Env = await createLegacyV1Envelope(payload, 'legacy-passphrase-123', 150000);

    const decrypted = await decryptPayload(v1Env, 'legacy-passphrase-123');
    assert.deepEqual(decrypted, payload);

    const unlocked = await unlockEnvelopeWithPassphrase(v1Env, 'legacy-passphrase-123');
    assert.deepEqual(unlocked.payload, payload);
    // 150k iteration v1 vault upgrades session key to 600k with a fresh salt for subsequent saves
    assert.equal(unlocked.sessionKey.iterations, PBKDF2_ITERATIONS);
    assert.notEqual(unlocked.sessionKey.salt, v1Env.salt);
  });

  it('supports non-extractable session keys with fresh IV per save, cross-salt decrypt, and passphrase verification (M6)', async () => {
    const pass = 'correct-horse-battery-staple';
    const sessionKey = await createSessionKey(pass);

    const env1 = await encryptPayloadWithSessionKey({ notes: [], tags: ['a'] }, sessionKey, {
      revision: 1,
    });
    const env2 = await encryptPayloadWithSessionKey({ notes: [], tags: ['b'] }, sessionKey, {
      revision: 2,
    });
    // Same salt/key reused without PBKDF2 stall, but fresh random IV per save
    assert.equal(env1.salt, env2.salt);
    assert.notEqual(env1.iv, env2.iv);

    const dec2 = await decryptPayloadWithSessionKey(env2, sessionKey);
    assert.deepEqual(dec2.tags, ['b']);

    // Remote envelope encrypted on another device with the same passphrase but a DIFFERENT salt
    const remoteOtherSalt = await encryptPayload({ notes: [], tags: ['remote'] }, pass, {
      revision: 3,
    });
    assert.notEqual(remoteOtherSalt.salt, sessionKey.salt);
    const decRemote = await decryptPayloadWithSessionKey(remoteOtherSalt, sessionKey);
    assert.deepEqual(decRemote.tags, ['remote']);

    // Current passphrase verification without storing plaintext passphrase
    assert.equal(await verifySessionKeyPassphrase(sessionKey, pass), true);
    assert.equal(await verifySessionKeyPassphrase(sessionKey, 'wrong-passphrase-123'), false);
  });

  it('rejects decryption with wrong passphrase using VaultDecryptionError', async () => {
    const envelope = await encryptPayload({ notes: [], tags: [] }, 'passphrase-one');
    await assert.rejects(
      () => decryptPayload(envelope, 'passphrase-two'),
      (err) => err instanceof VaultDecryptionError
    );
  });

  it('rejects empty passphrase and invalid iteration counts', async () => {
    await assert.rejects(() => encryptPayload({ notes: [], tags: [] }, ''));
    const envelope = await encryptPayload({ notes: [], tags: [] }, 'valid-passphrase');
    await assert.rejects(() =>
      decryptPayload({ ...envelope, iterations: 100 }, 'valid-passphrase')
    );
  });

  it('strictly validates encrypted envelope shape and base64 byte lengths', () => {
    assert.equal(isValidEncryptedEnvelope(null), false);
    assert.equal(isValidEncryptedEnvelope({}), false);
    assert.equal(isValidEncryptedEnvelope({ salt: 'a', iv: 'b', ciphertext: 'c' }), false);
    assert.equal(
      isValidEncryptedEnvelope({ salt: 'AAAA', iv: 'AAAA', ciphertext: 'AAAA' }),
      false
    );
    // Valid byte lengths: 16B salt (24 b64), 12B iv (16 b64), 16B ciphertext (24 b64)
    const salt16 = Buffer.alloc(16, 1).toString('base64');
    const iv12 = Buffer.alloc(12, 2).toString('base64');
    const ct16 = Buffer.alloc(16, 3).toString('base64');
    assert.equal(isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: ct16 }), true);
    assert.equal(
      isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: ct16, version: 2 }),
      true
    );
    assert.equal(
      isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: ct16, version: 99 }),
      false
    );
    assert.equal(
      isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: ct16, cipher: 'AES-128-CBC' }),
      false
    );
    assert.equal(
      isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: ct16, iterations: 10 }),
      false
    );
    // Reject invalid base64 padding/characters and verify exact decoded byte lengths without atob()
    assert.equal(
      isValidEncryptedEnvelope({ salt: '====', iv: iv12, ciphertext: ct16 }),
      false
    );
    assert.equal(
      isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: 'A'.repeat(20) }),
      false
    );
    // 16 bytes exact -> 24 base64 chars with '==' padding (22 chars + '==')
    assert.equal(
      isValidEncryptedEnvelope({
        salt: salt16,
        iv: iv12,
        ciphertext: Buffer.alloc(16, 9).toString('base64'),
      }),
      true
    );
    // 15 bytes -> 20 base64 chars -> must fail MIN_CIPHERTEXT_BYTES (16)
    assert.equal(
      isValidEncryptedEnvelope({
        salt: salt16,
        iv: iv12,
        ciphertext: Buffer.alloc(15, 9).toString('base64'),
      }),
      false
    );
  });
});
