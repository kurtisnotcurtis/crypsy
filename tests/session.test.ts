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
  VaultSessionKey,
} from '../src/types';
import type { LocalSyncMeta, VaultCacheStorage } from '../src/vault/cache';
import {
  CURRENT_ENVELOPE_VERSION,
  VaultDecryptionError,
  envelopeFingerprint,
  isValidEncryptedEnvelope,
} from '../src/vault/crypto';
import {
  DEFAULT_WEBCRYPTO_ADAPTER,
  LEGACY_DEFAULT_DEVICE_SECRET,
  VaultSession,
  type PendingSyncConflict,
  type VaultCloudAdapter,
  type VaultCryptoAdapter,
} from '../src/vault/session';
import type { TabVaultUpdateNotice, VaultTabCoordinator } from '../src/vault/tab-sync';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FastKeyHandle {
  kind: 'test';
  passphrase: string;
}

/**
 * Fast deterministic test crypto adapter that preserves the exact v2 AAD contract,
 * `VaultSessionKey`, and `VaultDecryptionError` semantics without burning 600k PBKDF2
 * iterations per unit test. Supports optional async gates to test exact interleavings.
 */
function createFastCryptoAdapter(hooks: {
  beforeDecrypt?: () => Promise<void>;
  beforeEncrypt?: () => Promise<void>;
} = {}) {
  let counter = 0;

  const encode = async (
    plaintextObj: VaultPayload,
    passphrase: string,
    salt: string,
    options: { revision?: number; version?: number } = {}
  ): Promise<EncryptedEnvelope> => {
    if (!passphrase) throw new Error('Passphrase required');
    if (hooks.beforeEncrypt) await hooks.beforeEncrypt();
    counter++;
    const version = options.version ?? CURRENT_ENVELOPE_VERSION;
    const iv = Buffer.alloc(12, ((counter * 7) % 250) + 1).toString('base64');
    const rev = options.revision ?? 0;
    const body = JSON.stringify({ p: passphrase, rev, version, data: plaintextObj });
    const padded = body.length < 16 ? body.padEnd(16, ' ') : body;
    const ciphertext = Buffer.from(padded, 'utf8').toString('base64');
    return {
      version,
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
  };

  const decode = async <T = VaultPayload>(
    envelope: EncryptedEnvelope,
    passphrase: string
  ): Promise<T> => {
    if (!passphrase) throw new Error('Passphrase required');
    if (!isValidEncryptedEnvelope(envelope)) throw new Error('Invalid envelope');
    if (hooks.beforeDecrypt) await hooks.beforeDecrypt();
    let parsed: { p: string; rev?: number; version?: number; data: unknown };
    try {
      const raw = Buffer.from(envelope.ciphertext, 'base64').toString('utf8');
      parsed = JSON.parse(raw) as { p: string; rev?: number; version?: number; data: unknown };
    } catch {
      throw new VaultDecryptionError();
    }
    if (parsed.p !== passphrase) {
      throw new VaultDecryptionError();
    }
    const envVer = envelope.version ?? 1;
    if (envVer >= 2 || (parsed.version ?? 1) >= 2) {
      if (envVer !== (parsed.version ?? 1) || (envelope.revision ?? 0) !== (parsed.rev ?? 0)) {
        throw new VaultDecryptionError();
      }
    }
    return parsed.data as T;
  };

  const adapter: VaultCryptoAdapter & {
    encryptForTest: (
      payload: VaultPayload,
      passphrase: string,
      options?: { revision?: number; version?: number }
    ) => Promise<EncryptedEnvelope>;
  } = {
    isValidEncryptedEnvelope,
    async createSessionKey(passphrase: string): Promise<VaultSessionKey> {
      counter++;
      return {
        salt: Buffer.alloc(16, (counter % 250) + 1).toString('base64'),
        iterations: 600000,
        _handle: { kind: 'test', passphrase } satisfies FastKeyHandle,
      };
    },
    async unlockEnvelope<T = VaultPayload>(envelope: EncryptedEnvelope, passphrase: string) {
      const payload = await decode<T>(envelope, passphrase);
      const sessionKey: VaultSessionKey = {
        salt: envelope.salt,
        iterations: 600000,
        _handle: { kind: 'test', passphrase } satisfies FastKeyHandle,
      };
      return { payload, sessionKey };
    },
    async encryptWithKey(plaintextObj, sessionKey, options = {}) {
      const handle = sessionKey._handle as FastKeyHandle;
      return encode(plaintextObj, handle.passphrase, sessionKey.salt, options);
    },
    async decryptWithKey<T = VaultPayload>(envelope: EncryptedEnvelope, sessionKey: VaultSessionKey) {
      const handle = sessionKey._handle as FastKeyHandle;
      return decode<T>(envelope, handle.passphrase);
    },
    async verifyPassphrase(sessionKey, candidatePassphrase) {
      const handle = sessionKey._handle as FastKeyHandle;
      return handle.passphrase === candidatePassphrase;
    },
    async decryptLegacy<T = VaultPayload>(envelope: EncryptedEnvelope, passphrase: string) {
      return decode<T>(envelope, passphrase);
    },
    async encryptForTest(payload, passphrase, options = {}) {
      counter++;
      const salt = Buffer.alloc(16, (counter % 250) + 1).toString('base64');
      return encode(payload, passphrase, salt, options);
    },
  };
  return adapter;
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

/** Shared in-memory cross-tab bus + exclusive lock for multi-tab tests (H6). */
function createSharedTabBus() {
  let lockChain: Promise<unknown> = Promise.resolve();
  const subscribers = new Map<string, Set<(notice: TabVaultUpdateNotice) => void>>();

  const createCoordinator = (tabId: string): VaultTabCoordinator => {
    const myListeners = new Set<(notice: TabVaultUpdateNotice) => void>();
    subscribers.set(tabId, myListeners);
    return {
      tabId,
      withExclusiveLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        const next = lockChain.then(fn, fn);
        lockChain = next.then(
          () => undefined,
          () => undefined
        );
        return next;
      },
      notifyVaultUpdated: (fingerprint, revision) => {
        const notice: TabVaultUpdateNotice = {
          fingerprint,
          revision,
          sourceTabId: tabId,
          at: Date.now(),
        };
        for (const [peerId, cbs] of subscribers.entries()) {
          if (peerId === tabId) continue;
          for (const cb of cbs) cb(notice);
        }
      },
      onRemoteTabUpdated: (cb) => {
        myListeners.add(cb);
        return () => myListeners.delete(cb);
      },
    };
  };

  return { createCoordinator };
}

function createSharedBackend(opts: {
  initialCloudStatus?: CloudConnectionStatus;
  initialCloudRead?: CloudReadResult | undefined;
} = {}) {
  let cachedEnvelope: EncryptedEnvelope | null = null;
  let syncMeta: LocalSyncMeta = {
    lastSyncedFingerprint: null,
    hasUnsyncedLocalChanges: false,
    highestAcceptedRevision: 0,
    highestAcceptedVersion: 1,
  };
  let failNextCacheSave = false;
  let hangNextCacheSave = false;
  let beforeCacheSaveHook: (() => Promise<void>) | null = null;
  let beforeCloudWriteHook: (() => Promise<void>) | null = null;
  let failNextCloudWrite = false;

  const cache: VaultCacheStorage = {
    async saveEnvelope(env) {
      if (beforeCacheSaveHook) {
        const hook = beforeCacheSaveHook;
        beforeCacheSaveHook = null;
        await hook();
      }
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
      syncMeta = {
        lastSyncedFingerprint: m.lastSyncedFingerprint,
        hasUnsyncedLocalChanges: m.hasUnsyncedLocalChanges,
        highestAcceptedRevision: Math.max(
          syncMeta.highestAcceptedRevision ?? 0,
          m.highestAcceptedRevision ?? 0
        ),
        highestAcceptedVersion: Math.max(
          syncMeta.highestAcceptedVersion ?? 1,
          m.highestAcceptedVersion ?? 1
        ),
      };
    },
  };

  let cloudStatus: CloudConnectionStatus = opts.initialCloudStatus ?? 'unlinked';
  let cloudFile: { envelope: EncryptedEnvelope; stamp: CloudFileStamp } | null = null;
  let cloudCorruptMessage: string | null = null;
  let acceptedCloudFp: string | null = null;
  let notifiedCloudFp: string | null = null;
  let initialCloudRead = opts.initialCloudRead;

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
      if (initialCloudRead) {
        const res = initialCloudRead;
        initialCloudRead = undefined;
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
      if (beforeCloudWriteHook) {
        const hook = beforeCloudWriteHook;
        beforeCloudWriteHook = null;
        await hook();
      }
      if (failNextCloudWrite) {
        failNextCloudWrite = false;
        return { status: 'error', message: 'Injected cloud write failure' };
      }
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
            notifiedCloudFp = cloudFile.stamp.fingerprint;
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
      notifiedCloudFp = stamp.fingerprint;
      return { status: 'ok', stamp };
    },
    markRemoteStampAccepted(stamp) {
      acceptedCloudFp = stamp?.fingerprint ?? null;
      notifiedCloudFp = stamp?.fingerprint ?? null;
    },
    markRemoteFingerprintNotified(fp) {
      notifiedCloudFp = fp;
    },
    async reconnectSavedHandle() {
      cloudStatus = 'connected';
      return true;
    },
  };

  return {
    cache,
    cloud,
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
    get notifiedCloudFp() {
      return notifiedCloudFp;
    },
    setCloudEnvelope,
    setCloudCorrupt: (msg: string) => {
      cloudCorruptMessage = msg;
    },
    setCloudStatus: (st: CloudConnectionStatus) => {
      cloudStatus = st;
    },
    set failNextCacheSave(v: boolean) {
      failNextCacheSave = v;
    },
    set hangNextCacheSave(v: boolean) {
      hangNextCacheSave = v;
    },
    set beforeCacheSaveHook(fn: (() => Promise<void>) | null) {
      beforeCacheSaveHook = fn;
    },
    set beforeCloudWriteHook(fn: (() => Promise<void>) | null) {
      beforeCloudWriteHook = fn;
    },
    set failNextCloudWrite(v: boolean) {
      failNextCloudWrite = v;
    },
  };
}

function createHarness(opts: {
  initialCloudStatus?: CloudConnectionStatus;
  initialCloudRead?: CloudReadResult | undefined;
  confirmResult?: boolean;
  failRenderOnce?: boolean;
  crypto?: ReturnType<typeof createFastCryptoAdapter>;
  backend?: ReturnType<typeof createSharedBackend>;
  tabs?: VaultTabCoordinator;
  onCommitDraftsSideEffect?: () => void;
} = {}) {
  const crypto = opts.crypto ?? createFastCryptoAdapter();
  const backend = opts.backend ?? createSharedBackend(opts);

  let sessionKey: VaultSessionKey | null = null;
  let lastEncryptedEnvelope: EncryptedEnvelope | null = null;
  let payload: VaultPayload = { notes: [], tags: [], boards: [] };
  let busyEditing = false;
  let openDraftNote: Note | null = null;
  let failRenderOnce = Boolean(opts.failRenderOnce);
  let confirmResult = opts.confirmResult ?? true;
  let confirmMessages: string[] = [];
  let lockScreenHiddenCount = 0;
  const lockHistory: Array<{ mode: string; errorMsg?: string; canCancelImport?: boolean }> = [];
  const statuses: VaultSaveStatus[] = [];
  let latestConflict: PendingSyncConflict | null = null;

  const session = new VaultSession({
    cache: backend.cache,
    cloud: backend.cloud,
    crypto,
    ...(opts.tabs ? { tabs: opts.tabs } : {}),
    host: {
      get sessionKey() {
        return sessionKey;
      },
      set sessionKey(v) {
        sessionKey = v;
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
        opts.onCommitDraftsSideEffect?.();
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
      hideLockScreen: () => {
        lockScreenHiddenCount++;
      },
      onSaveStatusChanged: (st) => statuses.push(st),
      onCloudStatusChanged: () => {},
      onConflictChanged: (c) => {
        latestConflict = c;
      },
      confirmAction: (msg) => {
        confirmMessages.push(msg);
        return confirmResult;
      },
    },
  });

  return {
    crypto,
    backend,
    session,
    get cachedEnvelope() {
      return backend.cachedEnvelope;
    },
    set cachedEnvelope(v: EncryptedEnvelope | null) {
      backend.cachedEnvelope = v;
    },
    get syncMeta() {
      return backend.syncMeta;
    },
    get cloudFile() {
      return backend.cloudFile;
    },
    setCloudEnvelope: backend.setCloudEnvelope,
    setCloudCorrupt: backend.setCloudCorrupt,
    setCloudStatus: backend.setCloudStatus,
    get sessionKey() {
      return sessionKey;
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
      backend.failNextCacheSave = v;
    },
    set hangNextCacheSave(v: boolean) {
      backend.hangNextCacheSave = v;
    },
    set failRenderOnce(v: boolean) {
      failRenderOnce = v;
    },
    set confirmResult(v: boolean) {
      confirmResult = v;
    },
    get confirmMessages() {
      return confirmMessages;
    },
    get lockScreenHiddenCount() {
      return lockScreenHiddenCount;
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
    assert.equal(h.session.isUnlocked(), true);

    // Valid-shaped envelope encrypted with a DIFFERENT passphrase does not clobber cache
    const otherEnv = await h.crypto.encryptForTest(
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
    const legacyEnv = await h.crypto.encryptForTest(
      { notes: [makeNote('n-old', 'Legacy Note')], tags: [], boards: [] },
      LEGACY_DEFAULT_DEVICE_SECRET,
      { version: 1 }
    );

    await h.session.importEnvelope(legacyEnv, { source: 'file' });
    assert.equal(h.lockHistory[h.lockHistory.length - 1]?.mode, 'unlock');

    h.confirmResult = false;
    assert.equal(await h.session.tryBeginLegacyUpgrade(), false);
    assert.equal(h.lockHistory[h.lockHistory.length - 1]?.mode, 'unlock');

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

    h.busyEditing = true;
    const remoteEnv = await h.crypto.encryptForTest(
      {
        notes: [makeNote('n1', 'Initial', 1000), makeNote('n2', 'From Other Device', 2000)],
        tags: ['test', 'remote'],
        boards: [],
      },
      'sync-pass-123',
      { revision: 2 }
    );
    const remoteStamp = h.setCloudEnvelope(remoteEnv);

    await h.session.handleExternalUpdate(remoteEnv, remoteStamp);
    assert.ok(h.session.getPendingExternalUpdate());

    h.payload.notes.push(makeNote('n3', 'Local Edit', 3000));
    await h.session.persist();
    assert.ok(h.latestConflict);
    assert.equal(h.cloudFile?.stamp.fingerprint, remoteStamp.fingerprint);

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

    h.setCloudStatus('needs_permission');
    h.payload.notes.push(makeNote('n2', 'Offline Note', 2000));
    await h.session.persist();
    assert.equal(h.session.getSaveStatus().state, 'needs_permission');
    assert.equal(h.syncMeta.hasUnsyncedLocalChanges, true);
    assert.equal(h.cloudFile!.stamp.fingerprint, oldCloudFp);

    const res = await h.session.resumeCloudSync();
    assert.equal(res.reconnected, true);
    assert.equal(h.syncMeta.hasUnsyncedLocalChanges, false);
    assert.notEqual(h.cloudFile!.stamp.fingerprint, oldCloudFp);
    const decryptedCloud = await h.crypto.decryptLegacy(h.cloudFile!.envelope, 'perm-pass-123');
    assert.ok(decryptedCloud.notes.some((n) => n.id === 'n2'));
  });

  it('5. treats corrupt cloud vault as error instead of "not found" and refuses to overwrite', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    h.setCloudCorrupt('vault.crypsy.json is unreadable (invalid JSON) and was left untouched.');

    await h.session.init('connected');
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

    h.failNextCacheSave = true;
    h.payload.notes.push(makeNote('n2', 'Second'));
    await assert.rejects(() => h.session.persist(), /aborted/i);
    assert.equal(h.session.getSaveStatus().state, 'failed');

    h.payload.notes.push(makeNote('n3', 'Third'));
    await h.session.persist();
    assert.equal(h.session.getSaveStatus().state, 'saved');
    const decrypted = await h.crypto.decryptLegacy(h.cachedEnvelope!, 'cache-pass-123');
    assert.equal(decrypted.notes.length, 3);

    await h.session.lock({ flushPending: true });
    assert.equal(h.sessionKey, null);
  });

  it('7. commits open drafts on lock and bounds lock flush with a timeout', async () => {
    const h = createHarness();
    await h.session.createOrUpgradeVault('setup', 'draft-pass-123', {
      notes: [makeNote('n1', 'Saved')],
      tags: [],
      boards: [],
    });

    h.openDraftNote = makeNote('n-draft', 'Unsaved Draft');
    await h.session.lock({ flushPending: true });
    assert.equal(h.sessionKey, null);

    await h.session.unlockWithPassphrase('draft-pass-123');
    assert.ok(h.payload.notes.some((n) => n.id === 'n-draft'));

    h.openDraftNote = makeNote('n-hang', 'Hanging Draft');
    h.hangNextCacheSave = true;
    const start = Date.now();
    await h.session.lock({ flushPending: true, timeoutMs: 50 });
    assert.equal(h.sessionKey, null);
    assert.ok(Date.now() - start < 1000);
  });

  it('8. separates post-decrypt errors from VaultDecryptionError and rolls back state without clobbering cache (M8)', async () => {
    const h = createHarness();
    await h.session.createOrUpgradeVault('setup', 'good-pass-123', {
      notes: [makeNote('n1', 'Original Safe')],
      tags: [],
      boards: [],
    });
    const originalCached = h.cachedEnvelope!;
    await h.session.lock({ flushPending: false });

    // Import another vault whose render crashes -> cache MUST remain untouched!
    const crashEnv = await h.crypto.encryptForTest(
      { notes: [makeNote('n-crash', 'Bad Render')], tags: [], boards: [] },
      'good-pass-123',
      { revision: 2 }
    );
    await h.session.importEnvelope(crashEnv, { source: 'file' });
    h.failRenderOnce = true;
    await assert.rejects(
      () => h.session.unlockWithPassphrase('good-pass-123'),
      (err) => !(err instanceof VaultDecryptionError) && /rendering failed/i.test(String(err))
    );
    assert.equal(h.sessionKey, null);
    assert.equal(h.payload.notes.length, 0);
    assert.deepEqual(h.cachedEnvelope, originalCached);
  });

  // ---------------------------------------------------------------------------
  // Adversarial Review Regression Suite (C1, H1–H6, M4, M5, M6)
  // ---------------------------------------------------------------------------

  it('C1 (R1/R1b): lock with in-flight save + dirty draft NEVER replaces vault with empty state', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'c1-vault-passphrase', {
      notes: [makeNote('n1', 'Keep Me 1'), makeNote('n2', 'Keep Me 2')],
      tags: ['important'],
      boards: [],
    });

    // Gate the first save so it is in flight when lock() runs
    const saveGate = createDeferred<void>();
    h.backend.beforeCacheSaveHook = () => saveGate.promise;

    h.payload.notes.push(makeNote('n3', 'In-flight edit'));
    const inFlightSave = h.session.persist();

    // Open draft committed during lock() while inFlightSave is still active
    h.openDraftNote = makeNote('n4', 'Committed on lock');
    const lockPromise = h.session.lock({ flushPending: true });

    // Immediately after lock() starts, state & key are already wiped
    assert.equal(h.sessionKey, null);
    assert.equal(h.payload.notes.length, 0);

    // Release the in-flight save and wait for lock to complete
    saveGate.resolve();
    await Promise.all([inFlightSave, lockPromise]);

    // Both local cache AND cloud MUST retain all 4 notes (0% chance of 0-note wipe!)
    const cachedDec = await h.crypto.decryptLegacy(h.cachedEnvelope!, 'c1-vault-passphrase');
    const cloudDec = await h.crypto.decryptLegacy(h.cloudFile!.envelope, 'c1-vault-passphrase');
    assert.equal(cachedDec.notes.length, 4);
    assert.equal(cloudDec.notes.length, 4);
    assert.ok(cachedDec.notes.some((n) => n.id === 'n4'));
  });

  it('H1 (R16a/R16b): lock mid-decrypt can NEVER be silently undone by remote apply or unlock', async () => {
    const decryptGate = createDeferred<void>();
    let gateEnabled = false;
    const crypto = createFastCryptoAdapter({
      beforeDecrypt: async () => {
        if (gateEnabled) {
          gateEnabled = false;
          await decryptGate.promise;
        }
      },
    });
    const h = createHarness({ initialCloudStatus: 'connected', crypto });
    await h.session.createOrUpgradeVault('setup', 'h1-passphrase-123', {
      notes: [makeNote('n1', 'Private')],
      tags: [],
      boards: [],
    });

    const remoteEnv = await crypto.encryptForTest(
      { notes: [makeNote('n1', 'Private'), makeNote('n2', 'Remote')], tags: [], boards: [] },
      'h1-passphrase-123',
      { revision: 2 }
    );
    const stamp = h.setCloudEnvelope(remoteEnv);

    // Start remote update decrypt, then lock mid-decrypt!
    const hiddenBefore = h.lockScreenHiddenCount;
    gateEnabled = true;
    const extPromise = h.session.handleExternalUpdate(remoteEnv, stamp);
    await h.session.lock({ flushPending: false });
    decryptGate.resolve();
    await extPromise;

    assert.equal(h.session.isUnlocked(), false);
    assert.equal(h.payload.notes.length, 0);
    assert.equal(h.lockScreenHiddenCount, hiddenBefore);

    // R16b: lock mid-unlockWithPassphrase MUST ALSO abort unlock cleanly!
    const unlockGate = createDeferred<void>();
    const crypto2 = createFastCryptoAdapter({
      beforeDecrypt: async () => {
        if (gateEnabled) {
          gateEnabled = false;
          await unlockGate.promise;
        }
      },
    });
    const h2 = createHarness({ crypto: crypto2 });
    await h2.session.createOrUpgradeVault('setup', 'h1-passphrase-123', {
      notes: [makeNote('n1', 'Private')],
      tags: [],
      boards: [],
    });
    await h2.session.lock({ flushPending: false });

    const hiddenBefore2 = h2.lockScreenHiddenCount;
    gateEnabled = true;
    const unlockPromise = h2.session.unlockWithPassphrase('h1-passphrase-123');
    await h2.session.lock({ flushPending: false });
    unlockGate.resolve();
    await assert.rejects(() => unlockPromise, /cancelled/i);
    assert.equal(h2.session.isUnlocked(), false);
    assert.equal(h2.payload.notes.length, 0);
    assert.equal(h2.lockScreenHiddenCount, hiddenBefore2);
  });

  it('H2 (R2/R7): startup never clobbers cache with unverified cloud file, and refuses revision rollback without confirmation', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    const goodLocalEnv = await h.crypto.encryptForTest(
      { notes: [makeNote('n-local', 'My Real Vault')], tags: [], boards: [] },
      'my-real-passphrase',
      { revision: 5 }
    );
    h.cachedEnvelope = goodLocalEnv;

    // Attacker or another user places an unopenable cloud file in the folder
    const unopenableCloud = await h.crypto.encryptForTest(
      { notes: [makeNote('n-bad', 'Wrong Key')], tags: [], boards: [] },
      'unknown-attacker-key',
      { revision: 6 }
    );
    h.setCloudEnvelope(unopenableCloud);

    await h.session.init('connected');
    // Local cache MUST remain intact!
    assert.deepEqual(h.cachedEnvelope, goodLocalEnv);
    // Unlocking with user's passphrase fails on cloud file without clobbering cache
    await assert.rejects(
      () => h.session.unlockWithPassphrase('my-real-passphrase'),
      (err) => err instanceof VaultDecryptionError
    );
    assert.deepEqual(h.cachedEnvelope, goodLocalEnv);
    // Cancelling pending cloud import lets user unlock their intact local cache!
    h.session.cancelPendingImport();
    await h.session.unlockWithPassphrase('my-real-passphrase');
    assert.equal(h.payload.notes[0]?.id, 'n-local');

    // R7: Rollback from rev 5 to older rev 2 is refused when user declines confirmation
    const staleRev2 = await h.crypto.encryptForTest(
      { notes: [makeNote('n-old', 'Stale Rev 2')], tags: [], boards: [] },
      'my-real-passphrase',
      { revision: 2 }
    );
    const staleStamp = h.setCloudEnvelope(staleRev2);
    h.confirmResult = false;
    await h.session.handleExternalUpdate(staleRev2, staleStamp);
    // Still has rev 5 local vault AND raised conflict instead of silently rolling back!
    assert.equal(h.payload.notes[0]?.id, 'n-local');
    assert.ok(h.latestConflict);
  });

  it('H3 (R13/R3): sync conflicts stay sticky across polls and across restarts', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'h3-passphrase-123', {
      notes: [makeNote('n1', 'Base')],
      tags: [],
      boards: [],
    });

    // Remote changes cloud file
    const remoteEnv = await h.crypto.encryptForTest(
      { notes: [makeNote('n1', 'Base'), makeNote('n-rem', 'Remote')], tags: [], boards: [] },
      'h3-passphrase-123',
      { revision: 2 }
    );
    const remoteStamp = h.setCloudEnvelope(remoteEnv);

    // Local writes -> conflict raised!
    h.payload.notes.push(makeNote('n-loc', 'Local'));
    await h.session.persist();
    assert.ok(h.latestConflict);

    // Next 3.5s poll delivers the remote envelope (or even a newer remote envelope) ->
    // MUST NOT overwrite local state and MUST NOT clear conflict banner!
    await h.session.handleExternalUpdate(remoteEnv, remoteStamp);
    assert.ok(h.latestConflict);
    assert.ok(h.payload.notes.some((n) => n.id === 'n-loc'));

    // R3: Simulate restart with unsynced local changes + diverged cloud file
    const hRestart = createHarness({
      initialCloudStatus: 'connected',
      backend: h.backend,
      crypto: h.crypto,
    });
    await hRestart.session.init('connected');
    assert.ok(hRestart.latestConflict);
    // Poll arrives while locked -> MUST NOT swap unlock target to remote!
    await hRestart.session.handleExternalUpdate(remoteEnv, remoteStamp);
    await hRestart.session.unlockWithPassphrase('h3-passphrase-123');
    // Unlocked vault MUST still contain our local unsynced note, and conflict stays visible!
    assert.ok(hRestart.payload.notes.some((n) => n.id === 'n-loc'));
    assert.ok(hRestart.latestConflict);
  });

  it('H4 (R4): remote update mid-decrypt defers cleanly when user starts editing', async () => {
    const decryptGate = createDeferred<void>();
    let gateEnabled = false;
    const crypto = createFastCryptoAdapter({
      beforeDecrypt: async () => {
        if (gateEnabled) {
          gateEnabled = false;
          await decryptGate.promise;
        }
      },
    });
    const h = createHarness({ initialCloudStatus: 'connected', crypto });
    await h.session.createOrUpgradeVault('setup', 'h4-passphrase-123', {
      notes: [makeNote('n1', 'Initial')],
      tags: [],
      boards: [],
    });

    const remoteEnv = await crypto.encryptForTest(
      { notes: [makeNote('n-remote', 'Remote Replacement')], tags: [], boards: [] },
      'h4-passphrase-123',
      { revision: 2 }
    );
    const stamp = h.setCloudEnvelope(remoteEnv);

    // User is idle when remote update arrives -> starts decrypting
    gateEnabled = true;
    const updatePromise = h.session.handleExternalUpdate(remoteEnv, stamp);

    // User starts editing (or pending board debounce starts) while decrypt is in flight!
    h.busyEditing = true;
    decryptGate.resolve();
    await updatePromise;

    // MUST NOT clobber active edit; instead queued as pendingExternalUpdate!
    assert.equal(h.payload.notes[0]?.id, 'n1');
    assert.ok(h.session.getPendingExternalUpdate());

    // Once editing finishes, flushing applies the remote update cleanly
    h.busyEditing = false;
    await h.session.flushPendingExternalUpdate();
    assert.equal(h.payload.notes[0]?.id, 'n-remote');
  });

  it('H5 (R5/R11): confirms before destructive cloud link replacement and locked file import overwrite', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'h5-passphrase-123', {
      notes: [makeNote('n-local', 'Important Local')],
      tags: [],
      boards: [],
    });

    // R5: Cloud folder already contains a different vault; declining confirmation cancels replacement
    const cloudExisting = await h.crypto.encryptForTest(
      { notes: [makeNote('n-other', 'Cloud Vault')], tags: [], boards: [] },
      'h5-passphrase-123',
      { revision: 3 }
    );
    h.confirmResult = false;
    const linkOutcome = await h.session.importEnvelope(cloudExisting, {
      requireConfirmIfNonEmpty: true,
      source: 'cloud',
    });
    assert.equal(linkOutcome, 'cancelled');
    assert.equal(h.payload.notes[0]?.id, 'n-local');

    // R11: Locked file import warns about cloud overwrite and respects cancel on unlock
    await h.session.lock({ flushPending: false });
    const localBefore = h.cachedEnvelope!;
    const cloudBefore = h.cloudFile!.stamp.fingerprint;

    const importedFile = await h.crypto.encryptForTest(
      { notes: [makeNote('n-file', 'Imported File')], tags: [], boards: [] },
      'h5-passphrase-123',
      { revision: 4 }
    );
    await h.session.importEnvelope(importedFile, { source: 'file' });
    assert.match(h.lockHistory[h.lockHistory.length - 1]?.errorMsg ?? '', /cloud vault/i);

    h.confirmResult = false;
    await assert.rejects(
      () => h.session.unlockWithPassphrase('h5-passphrase-123'),
      /cancelled/i
    );
    assert.deepEqual(h.cachedEnvelope, localBefore);
    assert.equal(h.cloudFile!.stamp.fingerprint, cloudBefore);
  });

  it('H6 (R15a/R15b): two browser tabs never silently overwrite each other (local-only AND cloud-linked)', async () => {
    // R15a: Local-only two tabs
    const busLocal = createSharedTabBus();
    const backendLocal = createSharedBackend({ initialCloudStatus: 'unlinked' });
    const cryptoLocal = createFastCryptoAdapter();

    const tabA = createHarness({
      backend: backendLocal,
      crypto: cryptoLocal,
      tabs: busLocal.createCoordinator('tab-a'),
    });
    await tabA.session.createOrUpgradeVault('setup', 'h6-passphrase-123', {
      notes: [makeNote('n1', 'Shared Base')],
      tags: [],
      boards: [],
    });

    const tabB = createHarness({
      backend: backendLocal,
      crypto: cryptoLocal,
      tabs: busLocal.createCoordinator('tab-b'),
    });
    await tabB.session.init('unlinked');
    await tabB.session.unlockWithPassphrase('h6-passphrase-123');

    // Tab B is busy editing when Tab A saves
    tabB.busyEditing = true;
    tabA.payload.notes.push(makeNote('n-tab-a', 'From Tab A', 2000));
    await tabA.session.persist();

    // Now Tab B saves its edit -> MUST raise conflict instead of clobbering Tab A!
    tabB.payload.notes.push(makeNote('n-tab-b', 'From Tab B', 3000));
    await tabB.session.persist();
    assert.ok(tabB.latestConflict);
    const cachedAfterConflict = await cryptoLocal.decryptLegacy(
      backendLocal.cachedEnvelope!,
      'h6-passphrase-123'
    );
    assert.ok(cachedAfterConflict.notes.some((n) => n.id === 'n-tab-a'));

    // R15b: Cloud-linked two tabs (shared localStorage syncMeta must not hide conflict!)
    const busCloud = createSharedTabBus();
    const backendCloud = createSharedBackend({ initialCloudStatus: 'connected' });
    const cryptoCloud = createFastCryptoAdapter();

    const cTabA = createHarness({
      backend: backendCloud,
      crypto: cryptoCloud,
      tabs: busCloud.createCoordinator('ctab-a'),
    });
    await cTabA.session.createOrUpgradeVault('setup', 'h6-passphrase-123', {
      notes: [makeNote('n1', 'Cloud Base')],
      tags: [],
      boards: [],
    });

    const cTabB = createHarness({
      backend: backendCloud,
      crypto: cryptoCloud,
      tabs: busCloud.createCoordinator('ctab-b'),
    });
    await cTabB.session.init('connected');
    await cTabB.session.unlockWithPassphrase('h6-passphrase-123');

    cTabB.busyEditing = true;
    cTabA.payload.notes.push(makeNote('n-ca', 'Cloud Tab A', 2000));
    await cTabA.session.persist();

    // Even though shared syncMeta.lastSyncedFingerprint now equals Tab A's fingerprint,
    // Tab B tracks its own base fingerprint and detects conflict!
    cTabB.payload.notes.push(makeNote('n-cb', 'Cloud Tab B', 3000));
    await cTabB.session.persist();
    assert.ok(cTabB.latestConflict);
    const cloudAfter = await cryptoCloud.decryptLegacy(
      backendCloud.cloudFile!.envelope,
      'h6-passphrase-123'
    );
    assert.ok(cloudAfter.notes.some((n) => n.id === 'n-ca'));

    tabA.session.dispose();
    tabB.session.dispose();
    cTabA.session.dispose();
    cTabB.session.dispose();
  });

  it('M4 (R10): Keep Local preserves force flag during in-flight save and does not clear banner on write error', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'm4-passphrase-123', {
      notes: [makeNote('n1', 'Initial')],
      tags: [],
      boards: [],
    });

    const remoteEnv = await h.crypto.encryptForTest(
      { notes: [makeNote('n-rem', 'Remote')], tags: [], boards: [] },
      'm4-passphrase-123',
      { revision: 2 }
    );
    h.setCloudEnvelope(remoteEnv);

    h.payload.notes.push(makeNote('n-loc', 'Local'));
    await h.session.persist();
    assert.ok(h.latestConflict);

    // If cloud write fails during Keep Local, conflict banner MUST remain visible!
    h.backend.failNextCloudWrite = true;
    await h.session.resolveConflict('keep_local');
    assert.ok(h.latestConflict);

    // Start an ordinary save (gated), then invoke Keep Local concurrently ->
    // Keep Local MUST wait and force-write cloud cleanly!
    const writeGate = createDeferred<void>();
    h.backend.beforeCloudWriteHook = () => writeGate.promise;
    const backgroundSave = h.session.persist();
    const keepLocalPromise = h.session.resolveConflict('keep_local');
    writeGate.resolve();
    await Promise.all([backgroundSave, keepLocalPromise]);

    assert.equal(h.latestConflict, null);
    const cloudDec = await h.crypto.decryptLegacy(h.cloudFile!.envelope, 'm4-passphrase-123');
    assert.ok(cloudDec.notes.some((n) => n.id === 'n-loc'));
  });

  it('M5 (R14): lock flush timeout does NOT abort already-encrypted draft write', async () => {
    const h = createHarness();
    await h.session.createOrUpgradeVault('setup', 'm5-passphrase-123', {
      notes: [makeNote('n1', 'Existing')],
      tags: [],
      boards: [],
    });

    const slowSave = createDeferred<void>();
    h.backend.beforeCacheSaveHook = () => slowSave.promise;
    h.openDraftNote = makeNote('n-slow-draft', 'Slow Draft');

    // Lock times out at 20ms, returning promptly with state & key wiped
    await h.session.lock({ flushPending: true, timeoutMs: 20 });
    assert.equal(h.sessionKey, null);
    assert.equal(h.payload.notes.length, 0);

    // Slow storage finishes AFTER lock timeout -> draft MUST STILL be saved!
    slowSave.resolve();
    await new Promise((r) => setTimeout(r, 20));

    await h.session.unlockWithPassphrase('m5-passphrase-123');
    assert.ok(h.payload.notes.some((n) => n.id === 'n-slow-draft'));
  });

  it('M6: rekeyPassphrase verifies current passphrase before deriving fresh salt and re-encrypting', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'old-passphrase-123', {
      notes: [makeNote('n1', 'Re-key Note')],
      tags: [],
      boards: [],
    });
    const oldSalt = h.cachedEnvelope!.salt;

    await assert.rejects(
      () => h.session.rekeyPassphrase('wrong-current-pass', 'new-passphrase-456'),
      (err) => err instanceof VaultDecryptionError
    );
    assert.equal(h.cachedEnvelope!.salt, oldSalt);

    await h.session.rekeyPassphrase('old-passphrase-123', 'new-passphrase-456');
    assert.notEqual(h.cachedEnvelope!.salt, oldSalt);

    await h.session.lock({ flushPending: false });
    await assert.rejects(
      () => h.session.unlockWithPassphrase('old-passphrase-123'),
      (err) => err instanceof VaultDecryptionError
    );
    await h.session.unlockWithPassphrase('new-passphrase-456');
    assert.equal(h.payload.notes[0]?.title, 'Re-key Note');
  });

  it('refuses to silently replace a non-empty unlocked vault with an empty remote vault', async () => {
    const h = createHarness({ initialCloudStatus: 'connected' });
    await h.session.createOrUpgradeVault('setup', 'empty-guard-pass', {
      notes: [makeNote('n1', 'Do Not Wipe')],
      tags: [],
      boards: [],
    });

    const emptyRemote = await h.crypto.encryptForTest(
      { notes: [], tags: [], boards: [] },
      'empty-guard-pass',
      { revision: 2 }
    );
    const stamp = h.setCloudEnvelope(emptyRemote);

    h.confirmResult = false;
    await h.session.handleExternalUpdate(emptyRemote, stamp);
    assert.equal(h.payload.notes.length, 1);
    assert.ok(h.latestConflict);
  });

  it('end-to-end real WebCrypto VaultSession create, lock-flush, unlock, and rekey', async () => {
    const backend = createSharedBackend({ initialCloudStatus: 'connected' });
    let sessionKey: VaultSessionKey | null = null;
    let lastEncryptedEnvelope: EncryptedEnvelope | null = null;
    let payload: VaultPayload = { notes: [], tags: [], boards: [] };
    let draft: Note | null = makeNote('n-draft', 'Draft Saved With Real WebCrypto');

    const session = new VaultSession({
      cache: backend.cache,
      cloud: backend.cloud,
      crypto: DEFAULT_WEBCRYPTO_ADAPTER,
      host: {
        get sessionKey() {
          return sessionKey;
        },
        set sessionKey(v) {
          sessionKey = v;
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
        hasLocalContent: () => payload.notes.length > 0,
        isBusyEditing: () => false,
        commitOpenDrafts: () => {
          if (!draft) return false;
          payload.notes.push(draft);
          draft = null;
          return true;
        },
        clearSensitiveStateAndDom: () => {
          payload = { notes: [], tags: [], boards: [] };
        },
        renderAll: () => {},
        refreshBoardFromExternal: () => {},
        showLockScreen: () => {},
        hideLockScreen: () => {},
        onSaveStatusChanged: () => {},
        onCloudStatusChanged: () => {},
        onConflictChanged: () => {},
        confirmAction: () => true,
      },
    });

    await session.createOrUpgradeVault('setup', 'real-webcrypto-pass-1', {
      notes: [makeNote('n1', 'Initial Real')],
      tags: ['crypto'],
      boards: [],
    });
    assert.equal(backend.cloudFile!.envelope.version, CURRENT_ENVELOPE_VERSION);

    await session.lock({ flushPending: true });
    assert.equal(sessionKey, null);
    assert.equal(payload.notes.length, 0);

    await session.unlockWithPassphrase('real-webcrypto-pass-1');
    assert.equal(payload.notes.length, 2);
    assert.ok(payload.notes.some((n) => n.id === 'n-draft'));

    await session.rekeyPassphrase('real-webcrypto-pass-1', 'real-webcrypto-pass-2');
    await session.lock({ flushPending: false });
    await session.unlockWithPassphrase('real-webcrypto-pass-2');
    assert.equal(payload.notes.length, 2);
  });
});
