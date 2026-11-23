import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PBKDF2_ITERATIONS,
  decryptPayload,
  encryptPayload,
  isValidEncryptedEnvelope,
} from '../src/crypto';
import type { VaultPayload } from '../src/types';

describe('crypto', () => {
  it('round-trips a vault payload with AES-256-GCM', async () => {
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
    const envelope = await encryptPayload(payload, 'correct-horse-battery');
    assert.equal(envelope.cipher, 'AES-256-GCM');
    assert.equal(envelope.kdf, 'PBKDF2-SHA256');
    assert.equal(envelope.iterations, PBKDF2_ITERATIONS);
    assert.equal(isValidEncryptedEnvelope(envelope), true);

    const decrypted = await decryptPayload(envelope, 'correct-horse-battery');
    assert.deepEqual(decrypted, payload);
  });

  it('rejects decryption with wrong passphrase', async () => {
    const envelope = await encryptPayload({ notes: [], tags: [] }, 'passphrase-one');
    await assert.rejects(() => decryptPayload(envelope, 'passphrase-two'));
  });

  it('rejects empty passphrase and invalid iteration counts', async () => {
    await assert.rejects(() => encryptPayload({ notes: [], tags: [] }, ''));
    const envelope = await encryptPayload({ notes: [], tags: [] }, 'valid-passphrase');
    await assert.rejects(() =>
      decryptPayload({ ...envelope, iterations: 100 }, 'valid-passphrase')
    );
  });

  it('validates encrypted envelope shape', () => {
    assert.equal(isValidEncryptedEnvelope(null), false);
    assert.equal(isValidEncryptedEnvelope({}), false);
    assert.equal(isValidEncryptedEnvelope({ salt: 'a', iv: 'b', ciphertext: '' }), false);
    assert.equal(isValidEncryptedEnvelope({ salt: 'a', iv: 'b', ciphertext: 'c' }), true);
  });
});
