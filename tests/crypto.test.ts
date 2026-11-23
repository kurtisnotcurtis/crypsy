import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PBKDF2_ITERATIONS,
  VaultDecryptionError,
  decryptPayload,
  encryptPayload,
  isValidEncryptedEnvelope,
} from '../src/vault/crypto';
import type { VaultPayload } from '../src/types';

describe('crypto', () => {
  it('round-trips a vault payload with AES-256-GCM and revision metadata', async () => {
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
    assert.equal(envelope.cipher, 'AES-256-GCM');
    assert.equal(envelope.kdf, 'PBKDF2-SHA256');
    assert.equal(envelope.iterations, PBKDF2_ITERATIONS);
    assert.equal(envelope.revision, 3);
    assert.equal(isValidEncryptedEnvelope(envelope), true);

    const decrypted = await decryptPayload(envelope, 'correct-horse-battery');
    assert.deepEqual(decrypted, payload);
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
      isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: ct16, cipher: 'AES-128-CBC' }),
      false
    );
    assert.equal(
      isValidEncryptedEnvelope({ salt: salt16, iv: iv12, ciphertext: ct16, iterations: 10 }),
      false
    );
  });
});
