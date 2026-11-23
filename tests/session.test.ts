import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CloudConnectionStatus,
  CloudFileStamp,
  CloudReadResult,
  CloudWriteResult,
  EncryptedEnvelope,
  Note,
  VaultPayload,
  VaultSaveStatus,
} from '../src/types';
import type { LocalSyncMeta, VaultCacheStorage } from '../src/vault/cache';
import {
  VaultDecryptionError,
  envelopeFingerprint,
  isValidEncryptedEnvelope,
} from '../src/vault/crypto';
import {
  LEGACY_DEFAULT_DEVICE_SECRET,
  VaultSession,
  type PendingSyncConflict,
  type VaultCloudAdapter,
  type VaultCryptoAdapter,
} from '../src/vault/session';

/**
 * Fast deterministic test crypto adapter that preserves the exact envelope shape
 * and `VaultDecryptionError` contract without burning 600k PBKDF2 iterations per test.
 */
function createFastCryptoAdapter(): VaultCryptoAdapter {
  let counter = 0;
  return {
    isValidEncryptedEnvelope,
    async encryptPayload(plaintextObj, passphrase, options = {}) {
      if (!passphrase) throw new Error('Passphrase required');
      counter++;
      const salt = Buffer.alloc(16, counter % 250 + 1).toString('base64');
      const iv = Buffer.alloc(12, (counter * 7) % 250 + 1).toString('base64');
      const body = JSON.stringify({ p: passphrase, data: plaintextObj });
      const padded = body.length < 16 ? body.padEnd(16, ' ') : body;
      const ciphertext = Buffer.from(padded, 'utf8').toString('base64');
      return {
        version: 1,
        appVersion: 'test',
        cipher: 'AES-256-GCM',
        kdf: 'PBKDF2-SHA256',
        iterations: 600000,
        salt,
        iv,
        ciphertext,
        updatedAt: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
        ...(options.revision ? { revision: options.revision } : {}),
      };
    },
    async decryptPayload<T = VaultPayload>(envelope: EncryptedEnvelope, passphrase: string) {
      if (!passphrase) throw new Error('Passphrase required');
      if (!isValidEncryptedEnvelope(envelope)) throw new Error('Invalid envelope');
      let parsed: { p: string; data: unknown };
      try {
        const raw = Buffer.from(envelope.ciphertext, 'base64').toString('utf8');
        parsed = JSON.parse(raw) as { p: string; data: unknown };
      } catch {
        throw new VaultDecryptionError();
      }
      if (parsed.p !== passphrase) {
        throw new VaultDecryptionError();
      }
      return parsed.data as T;
    },
  };
}

function makeNote(id: string, title: string, updatedAt = 1000): Note {
  return {
    id,
    title,
    description: `Body of ${title}`,
    tags: ['test'],
    pinned: false,
    color: 'default',
    createdAt: updatedAt,
    updatedAt,
  };
}

function createHarness(opts: {
  initialCloudStatus?: CloudConnectionStatus;
  initialCloudRead?: CloudReadResult | undefined;
  confirmResult?: boolean;
  failRenderOnce?: boolean;
} = {}) {
  const crypto = createFastCryptoAdapter();
  let cachedEnvelope: EncryptedEnvelope | null = null;
  let syncMeta: LocalSyncMeta = {
    lastSyncedFingerprint: null,
    hasUnsyncedLocalChanges: false,
  };
  let failNextCacheSave = false;
  let hangNextCacheSave = false;

  const cache: VaultCacheStorage = {
    async saveEnvelope(env) {
      if (hangNextCacheSave) {
        hangNextCacheSave = false;
        await new Promise(() => {});
      }
      if (failNextCacheSave) {
        failNextCacheSave = false;
        throw new Error('IndexedDB write aborted');
      }
      cachedEnvelope = structuredClone(env);
    },
    async loadEnvelope() {
      return cachedEnvelope ? structuredClone(cachedEnvelope) : null;
    },
    loadSyncMeta() {
      return { ...syncMeta };
    },
    saveSyncMeta(m) {
      syncMeta = { ...m };
    },
  };

  let cloudStatus: CloudConnectionStatus = opts.initialCloudStatus ?? 'unlinked';
  let cloudFile: { envelope: EncryptedEnvelope; stamp: CloudFileStamp } | null = null;
  let cloudCorruptMessage: string | null = null;
  let acceptedCloudFp: string | null = null;

  const setCloudEnvelope = (envelope: EncryptedEnvelope): CloudFileStamp => {
    const stamp: CloudFileStamp = {
      lastModified: Date.now(),
      size: JSON.stringify(envelope).length,
      fingerprint: envelopeFingerprint(envelope),
    };
    cloudFile = { envelope: structuredClone(envelope), stamp };
    cloudCorruptMessage = null;
    return stamp;
  };

  const cloud: VaultCloudAdapter = {
    isConnected: () => cloudStatus === 'connected',
    getConnectionStatus: () => cloudStatus,
    async readVault(): Promise<CloudReadResult> {
      if (opts.initialCloudRead) {
        const res = opts.initialCloudRead;
        opts.initialCloudRead = undefined;
        return res;
      }
      if (cloudStatus === 'unlinked') return { status: 'unlinked' };
      if (cloudStatus === 'needs_permission') return { status: 'no_permission' };
      if (cloudCorruptMessage) return { status: 'corrupt', message: cloudCorruptMessage };
      if (!cloudFile) return { status: 'not_found' };
      return {
        status: 'ok',
        envelope: structuredClone(cloudFile.envelope),
        stamp: { ...cloudFile.stamp },
      };
    },
    async writeVault(envelope, options = {}): Promise<CloudWriteResult> {
      if (cloudStatus === 'unlinked') return { status: 'unlinked' };
      if (cloudStatus === 'needs_permission') return { status: 'no_permission' };
      if (!options.force) {
        if (cloudCorruptMessage) {
          return { status: 'error', message: 'Existing file is corrupt; refusing to overwrite.' };
        }
        if (cloudFile) {
          const expectedFp =
            options.expectedFingerprint !== undefined
              ? options.expectedFingerprint
              : acceptedCloudFp;
          if (expectedFp === null || cloudFile.stamp.fingerprint !== expectedFp) {
            return {
              status: 'conflict',
              remoteEnvelope: structuredClone(cloudFile.envelope),
              stamp: { ...cloudFile.stamp },
            };
          }
        }
      }
      const stamp = setCloudEnvelope(envelope);
      acceptedCloudFp = stamp.fingerprint;
      return { status: 'ok', stamp };
    },
    markRemoteStampAccepted(stamp) {
      acceptedCloudFp = stamp?.fingerprint ?? null;
    },
    async reconnectSavedHandle() {
      cloudStatus = 'connected';
      return true;
    },
  };

  let passphrase: string | null = null;
  let lastEncryptedEnvelope: EncryptedEnvelope | null = null;
  let payload: VaultPayload = { notes: [], tags: [], boards: [] };
  let busyEditing = false;
  let openDraftNote: Note | null = null;
  let failRenderOnce = Boolean(opts.failRenderOnce);
  let confirmResult = opts.confirmResult ?? true;
  const lockHistory: Array<{ mode: string; errorMsg?: string; canCancelImport?: boolean }> = [];
  const statuses: VaultSaveStatus[] = [];
  let latestConflict: PendingSyncConflict | null = null;

  const session = new VaultSession({
    cache,
    cloud,
    crypto,
    host: {
      get passphrase() {
        return passphrase;
      },
      set passphrase(v) {
        passphrase = v;
      },
      get lastEncryptedEnvelope() {
        return lastEncryptedEnvelope;
      },
      set lastEncryptedEnvelope(v) {
        lastEncryptedEnvelope = v;
      },
      getPayloadSnapshot: () => payload,
      applyPayload: (next) => {
        payload = next;
      },
      hasLocalContent: () => payload.notes.length > 0 || (payload.boards?.length ?? 0) > 0,
      isBusyEditing: () => busyEditing,
      commitOpenDrafts: () => {
        if (!openDraftNote) return false;
        payload.notes.unshift(openDraftNote);
        openDraftNote = null;
        return true;
      },
      clearSensitiveStateAndDom: () => {
        payload = { notes: [], tags: [], boards: [] };
      },
      renderAll: () => {
        if (failRenderOnce) {
          failRenderOnce = false;
          throw new Error('Render crash');
        }
      },
      refreshBoardFromExternal: () => {},
      showLockScreen: (mode, errorMsg, options) => {
        lockHistory.push({
          mode,
          ...(errorMsg !== undefined ? { errorMsg } : {}),
          ...(options?.canCancelImport !== undefined
            ? { canCancelImport: options.canCancelImport }
            : {}),
        });
      },
      hideLockScreen: () => {},
      onSaveStatusChanged: (st) => statuses.push(st),
      onCloudStatusChanged: () => {},
      onConflictChanged: (c) => {
        latestConflict = c;
      },
      confirmAction: () => confirmResult,
    },
  });

  return {
    crypto,
    session,
    get cachedEnvelope() {
      return cachedEnvelope;
    },
    set cachedEnvelope(v: EncryptedEnvelope | null) {
      cachedEnvelope = v;
    },
    get syncMeta() {
      return syncMeta;
    },
    get cloudFile() {
      return cloudFile;
    },
    setCloudEnvelope,
    setCloudCorrupt: (msg: string) => {
      cloudCorruptMessage = msg;
    },
    setCloudStatus: (st: CloudConnectionStatus) => {
      cloudStatus = st;
    },
    get passphrase() {
      return passphrase;
    },
    get payload() {
      return payload;
    },
    set payload(v: VaultPayload) {
      payload = v;
    },
    set busyEditing(v: boolean) {
      busyEditing = v;
    },
    set openDraftNote(v: Note | null) {
      openDraftNote = v;
    },
    set failNextCacheSave(v: boolean) {
      failNextCacheSave = v;
    },
    set hangNextCacheSave(v: boolean) {
      hangNextCacheSave = v;
    },
    set failRenderOnce(v: boolean) {
      failRenderOnce = v;
    },
    set confirmResult(v: boolean) {
      confirmResult = v;
    },
    lockHistory,
    statuses,
    get latestConflict() {
      return latestConflict;
    },
  };
}

describe('VaultSession stateful reliability & security regressions', () => {
  it('1. rejects malformed/unopenable import without overwriting local cache', async () => {
    const h = createHarness();
    await h.session.createOrUpgradeVault('setup', 'my-secret-pass', {
      notes: [makeNote('n1', 'Original')],
      tags: ['test'],
      boards: [],
    });
    const originalCached = h.cachedEnvelope!;

    // Malformed short envelope fails immediately without touching cache
    await assert.rejects(() =>
      h.session.importEnvelope({ salt: 'AAAA', iv: 'AAAA', ciphertext: 'AAAA' }, { source: 'file' })
    );
    assert.deepEqual(h.cachedEnvelope, originalCached);
    assert.equal(h.passphrase, 'my-secret-pass');

    // Valid-shaped envelope encrypted with a DIFFERENT passphrase does not clobber cache
    const otherEnv = await h.crypto.encryptPayload(
      { notes: [makeNote('n2', 'Other')], tags: [], boards: [] },
      'different-passphrase'
    );
    const outcome = await h.session.importEnvelope(otherEnv, {
      requireConfirmIfNonEmpty: true,
      source: 'file',
    });
    assert.equal(outcome, 'needs_unlock');
    assert.deepEqual(h.cachedEnvelope, originalCached);

    // Cancelling pending import restores unlocking the original vault
    h.session.cancelPendingImport();
    await h.session.unlockWithPassphrase('my-secret-pass');
    assert.equal(h.payload.notes[0]?.title, 'Original');
  });

  it('2. does NOT auto-decrypt legacy default-key files; requires explicit confirmation', async () => {
    const h = createHarness();
    const legacyEnv = await h.crypto.encryptPayload(
      { notes: [makeNote('n-old', 'Legacy Note')], tags: [], boards: [] },
      LEGACY_DEFAULT_DEVICE_SECRET
    );

    await h.session.importEnvelope(legacyEnv, { source: 'file' });
    // Must land in normal 'unlock' mode, NOT 'upgrade' mode
    assert.equal(h.lockHistory[h.lockHistory.length - 1]?.mode, 'unlock');

    // Declining confirmation refuses legacy decrypt
    h.confirmResult = false;
    assert.equal(await h.session.tryBeginLegacyUpgrade(), false);
    assert.equal(h.lockHistory[h.lockHistory.length - 1]?.mode, 'unlock');

    // Accepting confirmation enters 'upgrade' mode safely
    h.confirmResult = true;
    assert.equal(await h.session.tryBeginLegacyUpgrade(), true);
    assert.equal(h.lockHistory[h.lockHistory.length - 1]?.mode, 'upgrade');
  });

  it('3. queues remote updates while busy and refuses to overwrite modified cloud file', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'sync-pass-123', {
      notes: [makeNote('n1', 'Initial', 1000)],
      tags: ['test'],
      boards: [],
    });

    // User opens a note modal (busy editing)
    h.busyEditing = true;

    // Another device updates vault.crypsy.json with n2
    const remoteEnv = await h.crypto.encryptPayload(
      {
        notes: [makeNote('n1', 'Initial', 1000), makeNote('n2', 'From Other Device', 2000)],
        tags: ['test', 'remote'],
        boards: [],
      },
      'sync-pass-123',
      { revision: 2 }
    );
    const remoteStamp = h.setCloudEnvelope(remoteEnv);

    // Poll delivers update while busy -> queued, NOT dropped
    await h.session.handleExternalUpdate(remoteEnv, remoteStamp);
    assert.ok(h.session.getPendingExternalUpdate());

    // User saves a local edit -> write MUST detect conflict and NOT overwrite n2 on disk!
    h.payload.notes.push(makeNote('n3', 'Local Edit', 3000));
    await h.session.persist();
    assert.ok(h.latestConflict);
    assert.equal(h.cloudFile?.stamp.fingerprint, remoteStamp.fingerprint);

    // Resolving conflict with 'merge' keeps BOTH remote n2 and local n3!
    h.busyEditing = false;
    await h.session.resolveConflict('merge');
    assert.equal(h.latestConflict, null);
    assert.ok(h.payload.notes.some((n) => n.id === 'n2'));
    assert.ok(h.payload.notes.some((n) => n.id === 'n3'));
    assert.notEqual(h.cloudFile?.stamp.fingerprint, remoteStamp.fingerprint);
  });

  it('4. tracks unsynced work when permission is missing and preserves it on Resume', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'perm-pass-123', {
      notes: [makeNote('n1', 'Initial', 1000)],
      tags: ['test'],
      boards: [],
    });
    const oldCloudFp = h.cloudFile!.stamp.fingerprint;

    // Simulate browser restart losing folder permission
    h.setCloudStatus('needs_permission');

    // User adds a note while folder permission is missing
    h.payload.notes.push(makeNote('n2', 'Offline Note', 2000));
    await h.session.persist();
    assert.equal(h.session.getSaveStatus().state, 'needs_permission');
    assert.equal(h.syncMeta.hasUnsyncedLocalChanges, true);
    assert.equal(h.cloudFile!.stamp.fingerprint, oldCloudFp);

    // User clicks Resume -> local unsynced note must NOT be overwritten by older cloud copy;
    // instead it pushes the newer local envelope to cloud!
    const res = await h.session.resumeCloudSync();
    assert.equal(res.reconnected, true);
    assert.equal(h.syncMeta.hasUnsyncedLocalChanges, false);
    assert.notEqual(h.cloudFile!.stamp.fingerprint, oldCloudFp);
    const decryptedCloud = await h.crypto.decryptPayload(h.cloudFile!.envelope, 'perm-pass-123');
    assert.ok(decryptedCloud.notes.some((n) => n.id === 'n2'));
  });

  it('5. treats corrupt cloud vault as error instead of "not found" and refuses to overwrite', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    h.setCloudCorrupt('vault.crypsy.json is unreadable (invalid JSON) and was left untouched.');

    await h.session.init('connected');
    // Must NOT enter 'setup' mode
    assert.equal(h.lockHistory[h.lockHistory.length - 1]?.mode, 'unlock');
    assert.match(h.lockHistory[h.lockHistory.length - 1]?.errorMsg ?? '', /unreadable/i);
  });

  it('6. recovers cleanly from a failed/aborted cache write so saving and locking keep working', async () => {
    const h = createHarness();
    await h.session.createOrUpgradeVault('setup', 'cache-pass-123', {
      notes: [makeNote('n1', 'First')],
      tags: [],
      boards: [],
    });

    // Inject one aborted cache write
    h.failNextCacheSave = true;
    h.payload.notes.push(makeNote('n2', 'Second'));
    await assert.rejects(() => h.session.persist(), /aborted/i);
    assert.equal(h.session.getSaveStatus().state, 'failed');

    // Subsequent save MUST succeed (single-flight promise did not wedge!)
    h.payload.notes.push(makeNote('n3', 'Third'));
    await h.session.persist();
    assert.equal(h.session.getSaveStatus().state, 'saved');
    const decrypted = await h.crypto.decryptPayload(h.cachedEnvelope!, 'cache-pass-123');
    assert.equal(decrypted.notes.length, 3);

    // Locking MUST also succeed without hanging
    await h.session.lock({ flushPending: true });
    assert.equal(h.passphrase, null);
  });

  it('7. commits open drafts on lock and bounds lock flush with a timeout', async () => {
    const h = createHarness();
    await h.session.createOrUpgradeVault('setup', 'draft-pass-123', {
      notes: [makeNote('n1', 'Saved')],
      tags: [],
      boards: [],
    });

    // Open draft unsaved in modal/composer
    h.openDraftNote = makeNote('n-draft', 'Unsaved Draft');
    await h.session.lock({ flushPending: true });
    assert.equal(h.passphrase, null);

    // Unlock and verify draft was persisted before lock!
    await h.session.unlockWithPassphrase('draft-pass-123');
    assert.ok(h.payload.notes.some((n) => n.id === 'n-draft'));

    // Even if storage hangs forever, lock completes within timeoutMs
    h.openDraftNote = makeNote('n-hang', 'Hanging Draft');
    h.hangNextCacheSave = true;
    const start = Date.now();
    await h.session.lock({ flushPending: true, timeoutMs: 50 });
    assert.equal(h.passphrase, null);
    assert.ok(Date.now() - start < 1000);
  });

  it('8. separates post-decrypt errors from VaultDecryptionError and rolls back state', async () => {
    const h = createHarness();
    await h.session.createOrUpgradeVault('setup', 'good-pass-123', {
      notes: [makeNote('n1', 'Secret')],
      tags: [],
      boards: [],
    });
    await h.session.lock({ flushPending: false });

    h.failRenderOnce = true;
    await assert.rejects(
      () => h.session.unlockWithPassphrase('good-pass-123'),
      (err) => !(err instanceof VaultDecryptionError) && /rendering failed/i.test(String(err))
    );
    // Vault state must NOT be left populated behind the lock screen!
    assert.equal(h.passphrase, null);
    assert.equal(h.payload.notes.length, 0);
  });
});
