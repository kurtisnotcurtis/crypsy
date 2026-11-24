/**
 * Crypsy — Stateful Vault Load, Save, Sync, Conflict & Lock Session Engine
 *
 * Designed with injected cache, cloud, crypto, and cross-tab adapters so every
 * stateful failure mode (lock/save interleaving, lock-generation invalidation,
 * startup cache preservation, revision rollback protection, sticky sync conflicts,
 * serialized remote-apply vs local-edit ordering, cross-tab concurrency, and
 * render-before-commit isolation) is directly unit-testable.
 */

import type {
  CloudConnectionStatus,
  CloudFileStamp,
  CloudReadResult,
  CloudWriteResult,
  EncryptedEnvelope,
  VaultPayload,
  VaultSaveStatus,
  VaultSessionKey,
} from '../types';
import type { VaultCacheStorage } from './cache';
import {
  VaultDecryptionError,
  createSessionKey,
  decryptPayload,
  decryptPayloadWithSessionKey,
  encryptPayloadWithSessionKey,
  envelopeFingerprint,
  isValidEncryptedEnvelope,
  unlockEnvelopeWithPassphrase,
  verifySessionKeyPassphrase,
} from './crypto';
import { mergeVaultPayloads, normalizeVaultPayload } from './payload';
import { createNoopTabCoordinator, type VaultTabCoordinator } from './tab-sync';

export const LEGACY_DEFAULT_DEVICE_SECRET = 'crypsy-local-device-default-key-v1';

export interface VaultCryptoAdapter {
  createSessionKey: (passphrase: string) => Promise<VaultSessionKey>;
  unlockEnvelope: <T = VaultPayload>(
    envelope: EncryptedEnvelope,
    passphrase: string
  ) => Promise<{ payload: T; sessionKey: VaultSessionKey }>;
  encryptWithKey: (
    plaintextObj: VaultPayload,
    sessionKey: VaultSessionKey,
    options?: { revision?: number }
  ) => Promise<EncryptedEnvelope>;
  decryptWithKey: <T = VaultPayload>(
    envelope: EncryptedEnvelope,
    sessionKey: VaultSessionKey
  ) => Promise<T>;
  verifyPassphrase: (sessionKey: VaultSessionKey, candidatePassphrase: string) => Promise<boolean>;
  decryptLegacy: <T = VaultPayload>(
    envelope: EncryptedEnvelope,
    passphrase: string
  ) => Promise<T>;
  isValidEncryptedEnvelope: typeof isValidEncryptedEnvelope;
}

export interface VaultCloudAdapter {
  isConnected: () => boolean;
  getConnectionStatus: () => CloudConnectionStatus;
  readVault: () => Promise<CloudReadResult>;
  writeVault: (
    envelope: EncryptedEnvelope,
    options?: { force?: boolean; expectedFingerprint?: string | null }
  ) => Promise<CloudWriteResult>;
  markRemoteStampAccepted: (stamp: CloudFileStamp | null) => void;
  markRemoteFingerprintNotified?: (fingerprint: string | null) => void;
  reconnectSavedHandle: () => Promise<boolean>;
}

export interface VaultSessionState {
  sessionKey: VaultSessionKey | null;
  lastEncryptedEnvelope: EncryptedEnvelope | null;
  getPayloadSnapshot: () => VaultPayload;
  applyPayload: (payload: VaultPayload) => void;
  hasLocalContent: () => boolean;
  isBusyEditing: () => boolean;
  /**
   * Synchronously commits any open UI drafts into in-memory state ONLY.
   * MUST NOT start async persistence or flush pending remote updates.
   */
  commitOpenDrafts: () => boolean;
  clearSensitiveStateAndDom: () => void;
  renderAll: () => void;
  refreshBoardFromExternal: () => void;
  showLockScreen: (
    mode: 'unlock' | 'setup' | 'upgrade',
    errorMsg?: string,
    options?: { canCancelImport?: boolean }
  ) => void;
  hideLockScreen: () => void;
  onSaveStatusChanged: (status: VaultSaveStatus) => void;
  onCloudStatusChanged: (status?: CloudConnectionStatus) => void;
  onConflictChanged: (conflict: PendingSyncConflict | null) => void;
  confirmAction: (message: string) => boolean;
}

export interface PendingSyncConflict {
  remoteEnvelope: EncryptedEnvelope;
  remoteStamp: CloudFileStamp;
  message: string;
}

export interface PendingExternalUpdate {
  envelope: EncryptedEnvelope;
  stamp: CloudFileStamp;
  fromLocalTab?: boolean | undefined;
}

interface PendingImportState {
  envelope: EncryptedEnvelope;
  source: 'file' | 'cloud';
  stamp?: CloudFileStamp | undefined;
  /** True when user clicked "Load Cloud Copy" or confirmed import explicitly */
  bypassRollbackGuard?: boolean | undefined;
}

const DEFAULT_LOCK_FLUSH_TIMEOUT_MS = 5000;

export const DEFAULT_WEBCRYPTO_ADAPTER: VaultCryptoAdapter = {
  createSessionKey,
  unlockEnvelope: unlockEnvelopeWithPassphrase,
  encryptWithKey: encryptPayloadWithSessionKey,
  decryptWithKey: decryptPayloadWithSessionKey,
  verifyPassphrase: verifySessionKeyPassphrase,
  decryptLegacy: decryptPayload,
  isValidEncryptedEnvelope,
};

function isPayloadEmpty(payload: VaultPayload): boolean {
  return payload.notes.length === 0 && (payload.boards?.length ?? 0) === 0;
}

export class VaultSession {
  private readonly cache: VaultCacheStorage;
  private readonly cloud: VaultCloudAdapter;
  private readonly crypto: VaultCryptoAdapter;
  private readonly host: VaultSessionState;
  private readonly tabs: VaultTabCoordinator;
  private readonly unsubscribeTabSync: () => void;

  /** Monotonic generation incremented synchronously on every lock() to invalidate stale async work. */
  private lockGeneration = 0;
  private isLocking = false;

  /** Serialized FIFO queue for all mutating session I/O (saves, remote applies, conflicts, unlocks). */
  private opChain: Promise<void> = Promise.resolve();

  private activePersistPromise: Promise<void> | null = null;
  private persistAgainRequested = false;
  private persistAgainForceCloudWrite = false;
  private localWriteCounter = 0;

  /** Per-tab known fingerprints so another tab updating shared localStorage cannot mask conflicts. */
  private knownCacheFingerprint: string | null = null;
  private knownSyncedFingerprint: string | null = null;
  private highestAcceptedRevision = 0;
  private highestAcceptedVersion = 1;

  private pendingImport: PendingImportState | null = null;
  private pendingLegacyUpgradePayload: VaultPayload | null = null;
  private pendingExternalUpdate: PendingExternalUpdate | null = null;
  private pendingConflict: PendingSyncConflict | null = null;
  private saveStatus: VaultSaveStatus = { state: 'idle' };

  constructor(deps: {
    cache: VaultCacheStorage;
    cloud: VaultCloudAdapter;
    crypto?: VaultCryptoAdapter;
    tabs?: VaultTabCoordinator;
    host: VaultSessionState;
  }) {
    this.cache = deps.cache;
    this.cloud = deps.cloud;
    this.crypto = deps.crypto ?? DEFAULT_WEBCRYPTO_ADAPTER;
    this.tabs = deps.tabs ?? createNoopTabCoordinator();
    this.host = deps.host;

    this.unsubscribeTabSync = this.tabs.onRemoteTabUpdated((notice) => {
      if (notice.fingerprint === this.knownCacheFingerprint) return;
      void this.handlePeerTabNotice(notice.fingerprint, notice.at);
    });
  }

  public dispose(): void {
    this.unsubscribeTabSync();
  }

  public isUnlocked(): boolean {
    return this.host.sessionKey !== null;
  }

  public getLockGeneration(): number {
    return this.lockGeneration;
  }

  public getSaveStatus(): VaultSaveStatus {
    return this.saveStatus;
  }

  public getPendingConflict(): PendingSyncConflict | null {
    return this.pendingConflict;
  }

  public hasPendingImport(): boolean {
    return this.pendingImport !== null;
  }

  public getPendingExternalUpdate(): PendingExternalUpdate | null {
    return this.pendingExternalUpdate;
  }

  public getActiveUnlockTargetEnvelope(): EncryptedEnvelope | null {
    return this.pendingImport?.envelope ?? this.host.lastEncryptedEnvelope;
  }

  private setSaveStatus(status: VaultSaveStatus): void {
    this.saveStatus = status;
    this.host.onSaveStatusChanged(status);
  }

  private setConflict(conflict: PendingSyncConflict | null): void {
    this.pendingConflict = conflict;
    this.host.onConflictChanged(conflict);
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private recordAcceptedEnvelopeStats(envelope: EncryptedEnvelope): void {
    const rev = envelope.revision ?? 0;
    const ver = envelope.version ?? 1;
    if (rev > this.highestAcceptedRevision) {
      this.highestAcceptedRevision = rev;
    }
    if (ver > this.highestAcceptedVersion) {
      this.highestAcceptedVersion = ver;
    }
  }

  private saveSyncMetaWithHighWater(meta: {
    lastSyncedFingerprint: string | null;
    hasUnsyncedLocalChanges: boolean;
  }): void {
    this.cache.saveSyncMeta({
      lastSyncedFingerprint: meta.lastSyncedFingerprint,
      hasUnsyncedLocalChanges: meta.hasUnsyncedLocalChanges,
      highestAcceptedRevision: this.highestAcceptedRevision,
      highestAcceptedVersion: this.highestAcceptedVersion,
    });
  }

  private checkIncomingGuards(
    envelope: EncryptedEnvelope,
    normalized: VaultPayload,
    options: {
      source: 'file' | 'cloud';
      wasNonEmpty: boolean;
      bypassRollbackGuard?: boolean | undefined;
    }
  ): { allowed: true } | { allowed: false; reason: string } {
    if (options.source === 'file') {
      return { allowed: true };
    }

    const syncMeta = this.cache.loadSyncMeta();
    const knownMaxRev = Math.max(
      this.highestAcceptedRevision,
      syncMeta.highestAcceptedRevision ?? 0,
      this.host.lastEncryptedEnvelope?.revision ?? 0
    );
    const knownMaxVer = Math.max(
      this.highestAcceptedVersion,
      syncMeta.highestAcceptedVersion ?? 1,
      this.host.lastEncryptedEnvelope?.version ?? 1
    );
    const incomingRev = envelope.revision ?? 0;
    const incomingVer = envelope.version ?? 1;

    if (!options.bypassRollbackGuard && knownMaxRev > 0 && incomingRev < knownMaxRev) {
      const ok = this.host.confirmAction(
        `Warning: The incoming cloud vault is an older revision (rev ${incomingRev}) than your last accepted vault (rev ${knownMaxRev}). Loading it could roll back recent edits. Continue?`
      );
      if (!ok) {
        return {
          allowed: false,
          reason: `Refused to roll back from revision ${knownMaxRev} to older revision ${incomingRev}.`,
        };
      }
    }

    if (!options.bypassRollbackGuard && knownMaxVer >= 2 && incomingVer < 2) {
      const ok = this.host.confirmAction(
        'Warning: The incoming cloud vault uses an unauthenticated v1 envelope format while this device previously used authenticated v2 envelopes. Continue?'
      );
      if (!ok) {
        return {
          allowed: false,
          reason: 'Refused to downgrade from authenticated v2 envelope to legacy v1 format.',
        };
      }
    }

    if (!options.bypassRollbackGuard && options.wasNonEmpty && isPayloadEmpty(normalized)) {
      const ok = this.host.confirmAction(
        'Warning: The incoming cloud vault contains 0 notes and 0 boards, which would replace your currently loaded vault. Continue?'
      );
      if (!ok) {
        return {
          allowed: false,
          reason: 'Refused to replace a non-empty vault with an empty cloud vault.',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Startup initialization: loads cloud or local cache without EVER overwriting
   * the local cache with an unverified cloud envelope before decryption succeeds,
   * and without silently attempting the hardcoded legacy secret.
   */
  public async init(cloudStatus: CloudConnectionStatus): Promise<void> {
    const cachedEnvelope = await this.cache.loadEnvelope();
    const syncMeta = this.cache.loadSyncMeta();
    this.knownCacheFingerprint = cachedEnvelope ? envelopeFingerprint(cachedEnvelope) : null;
    this.knownSyncedFingerprint = syncMeta.lastSyncedFingerprint;
    this.highestAcceptedRevision = Math.max(
      syncMeta.highestAcceptedRevision ?? 0,
      cachedEnvelope?.revision ?? 0
    );
    this.highestAcceptedVersion = Math.max(
      syncMeta.highestAcceptedVersion ?? 1,
      cachedEnvelope?.version ?? 1
    );

    if (cloudStatus === 'connected') {
      const readRes = await this.cloud.readVault();
      if (readRes.status === 'corrupt') {
        if (cachedEnvelope) {
          this.host.lastEncryptedEnvelope = cachedEnvelope;
        }
        this.host.showLockScreen('unlock', readRes.message);
        this.setSaveStatus({ state: 'failed', message: readRes.message });
        return;
      }
      if (readRes.status === 'ok') {
        const cloudFp = readRes.stamp.fingerprint;
        const cachedFp = cachedEnvelope ? envelopeFingerprint(cachedEnvelope) : null;

        // Preserve unsynced local cache if local changes exist and differ from cloud
        if (cachedEnvelope && syncMeta.hasUnsyncedLocalChanges && cachedFp !== cloudFp) {
          this.host.lastEncryptedEnvelope = cachedEnvelope;
          if (syncMeta.lastSyncedFingerprint === cloudFp) {
            this.cloud.markRemoteStampAccepted(readRes.stamp);
          } else {
            this.cloud.markRemoteFingerprintNotified?.(cloudFp);
            this.setConflict({
              remoteEnvelope: readRes.envelope,
              remoteStamp: readRes.stamp,
              message: 'Both local cache and cloud vault changed while offline.',
            });
          }
          this.host.showLockScreen(
            'unlock',
            'Unsynced local changes detected — unlock to review or sync.'
          );
          return;
        }

        // Already identical to verified local cache -> unlock directly
        if (cachedEnvelope && cachedFp === cloudFp) {
          this.host.lastEncryptedEnvelope = cachedEnvelope;
          this.cloud.markRemoteStampAccepted(readRes.stamp);
          this.knownSyncedFingerprint = cloudFp;
          this.host.showLockScreen('unlock');
          return;
        }

        // Cloud envelope differs from (or exists without) local cache:
        // Hold in memory as a pending import until decryption & rollback checks pass!
        // NEVER clobber the local cache before the cloud envelope decrypts.
        this.host.lastEncryptedEnvelope = cachedEnvelope;
        this.pendingImport = {
          envelope: readRes.envelope,
          source: 'cloud',
          stamp: readRes.stamp,
        };
        this.cloud.markRemoteFingerprintNotified?.(cloudFp);
        this.host.showLockScreen('unlock', undefined, {
          canCancelImport: cachedEnvelope !== null,
        });
        return;
      }
      if (readRes.status === 'error') {
        if (cachedEnvelope) {
          this.host.lastEncryptedEnvelope = cachedEnvelope;
        }
        this.host.showLockScreen('unlock', `Cloud folder error: ${readRes.message}`);
        return;
      }
      // status === 'not_found' -> fall through to local cache or setup
    }

    if (cachedEnvelope) {
      this.host.lastEncryptedEnvelope = cachedEnvelope;
      this.host.showLockScreen('unlock');
      return;
    }

    this.host.showLockScreen('setup');
  }

  /**
   * Unlocks the active envelope (or a pending imported/startup-cloud envelope).
   * - Separates decryption failures (`VaultDecryptionError`) from post-decrypt errors.
   * - Validates rollback/downgrade guards before committing.
   * - Checks lock generation after every await so a concurrent lock cannot be undone.
   * - Renders UI BEFORE committing cache/cloud so render crashes never clobber stored vaults.
   */
  public async unlockWithPassphrase(passphrase: string): Promise<void> {
    const gen = this.lockGeneration;
    return this.runSerialized(async () => {
      if (this.lockGeneration !== gen) {
        throw new Error('Unlock cancelled because vault was locked.');
      }

      const pending = this.pendingImport;
      const target =
        pending?.envelope ?? this.host.lastEncryptedEnvelope ?? (await this.cache.loadEnvelope());
      if (this.lockGeneration !== gen) {
        throw new Error('Unlock cancelled because vault was locked.');
      }
      if (!target) {
        throw new Error('No encrypted vault found to unlock.');
      }
      if (!this.crypto.isValidEncryptedEnvelope(target)) {
        throw new Error('Encrypted vault envelope is malformed.');
      }

      // Step 1: Decrypt ONLY (throws VaultDecryptionError on wrong passphrase or tampered AAD)
      const { payload: rawDecrypted, sessionKey } = await this.crypto.unlockEnvelope(
        target,
        passphrase
      );
      if (this.lockGeneration !== gen) {
        throw new Error('Unlock cancelled because vault was locked.');
      }

      // Step 2: Validate & normalize payload before mutating state
      const normalized = normalizeVaultPayload(rawDecrypted);

      // Step 3: Guard against rollback/downgrade and destructive locked file imports
      if (pending) {
        if (pending.source === 'cloud') {
          const guard = this.checkIncomingGuards(target, normalized, {
            source: 'cloud',
            wasNonEmpty: false,
            bypassRollbackGuard: pending.bypassRollbackGuard,
          });
          if (!guard.allowed) {
            throw new Error(guard.reason);
          }
        } else if (pending.source === 'file') {
          const hasExistingLocal = this.host.lastEncryptedEnvelope !== null;
          const cloudConnected = this.cloud.isConnected();
          if (hasExistingLocal || cloudConnected) {
            const msg = cloudConnected
              ? 'Importing this vault file will replace your local vault AND overwrite vault.crypsy.json in your connected cloud folder. Continue?'
              : 'Importing this vault file will replace your existing local vault. Continue?';
            if (!this.host.confirmAction(msg)) {
              throw new Error('Vault file import cancelled.');
            }
          }
        }
      }

      if (this.lockGeneration !== gen) {
        throw new Error('Unlock cancelled because vault was locked.');
      }

      // Step 4: Apply state and render UI FIRST (before writing cache or cloud!)
      const prevEnvelope = this.host.lastEncryptedEnvelope;
      this.host.sessionKey = sessionKey;
      this.host.lastEncryptedEnvelope = target;
      this.host.applyPayload(normalized);

      try {
        this.host.renderAll();
        this.host.refreshBoardFromExternal();
      } catch (renderErr) {
        // Roll back unlocked state so sensitive data is not left behind lock screen
        this.host.clearSensitiveStateAndDom();
        this.host.sessionKey = null;
        this.host.lastEncryptedEnvelope = prevEnvelope;
        throw new Error(
          `Vault decrypted, but rendering failed: ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`
        );
      }

      if (this.lockGeneration !== gen) {
        this.host.clearSensitiveStateAndDom();
        this.host.sessionKey = null;
        this.host.lastEncryptedEnvelope = prevEnvelope;
        throw new Error('Unlock cancelled because vault was locked.');
      }

      // Step 5: Commit pending import / startup cloud envelope to cache (and cloud only for confirmed file import)
      this.pendingImport = null;
      this.pendingLegacyUpgradePayload = null;
      this.recordAcceptedEnvelopeStats(target);

      const targetFp = envelopeFingerprint(target);
      if (pending) {
        await this.tabs.withExclusiveLock(async () => {
          try {
            await this.cache.saveEnvelope(target);
            this.knownCacheFingerprint = targetFp;
            this.tabs.notifyVaultUpdated(targetFp, target.revision ?? 0);
          } catch (err) {
            this.setSaveStatus({
              state: 'failed',
              message:
                err instanceof Error ? err.message : 'Failed to save imported vault locally.',
            });
          }

          if (pending.source === 'cloud') {
            if (pending.stamp) {
              this.cloud.markRemoteStampAccepted(pending.stamp);
              this.knownSyncedFingerprint = pending.stamp.fingerprint;
              this.saveSyncMetaWithHighWater({
                lastSyncedFingerprint: pending.stamp.fingerprint,
                hasUnsyncedLocalChanges: false,
              });
            }
            this.setConflict(null);
            this.setSaveStatus({ state: 'saved', at: Date.now() });
          } else if (pending.source === 'file') {
            this.setConflict(null);
            if (this.cloud.isConnected()) {
              const writeRes = await this.cloud.writeVault(target, { force: true });
              this.handleCloudWriteOutcome(writeRes, target);
            } else {
              this.saveSyncMetaWithHighWater({
                lastSyncedFingerprint: null,
                hasUnsyncedLocalChanges: false,
              });
              this.setSaveStatus({ state: 'saved', at: Date.now() });
            }
          }
        });
      } else {
        this.knownCacheFingerprint = targetFp;
        const syncMeta = this.cache.loadSyncMeta();
        this.knownSyncedFingerprint = syncMeta.lastSyncedFingerprint;
        this.saveSyncMetaWithHighWater({
          lastSyncedFingerprint: syncMeta.lastSyncedFingerprint,
          hasUnsyncedLocalChanges: syncMeta.hasUnsyncedLocalChanges,
        });
      }

      if (this.lockGeneration !== gen) {
        this.host.clearSensitiveStateAndDom();
        this.host.sessionKey = null;
        throw new Error('Unlock cancelled because vault was locked.');
      }

      this.host.hideLockScreen();

      // If local cache had unsynced changes and cloud is connected without conflict, push now
      const syncMeta = this.cache.loadSyncMeta();
      if (syncMeta.hasUnsyncedLocalChanges && this.cloud.isConnected() && !this.pendingConflict) {
        void this.persist().catch(() => {});
      }
    });
  }

  /**
   * Explicitly gated legacy v1.x default-key migration.
   * Never runs automatically; requires explicit user confirmation.
   */
  public async tryBeginLegacyUpgrade(): Promise<boolean> {
    const gen = this.lockGeneration;
    const target = this.pendingImport?.envelope ?? this.host.lastEncryptedEnvelope;
    if (!target || !this.crypto.isValidEncryptedEnvelope(target)) {
      throw new Error('No valid vault file available for legacy migration.');
    }

    const confirmed = this.host.confirmAction(
      'Legacy v1.x vaults used a publicly known default key and cannot verify authorship. Anyone with write access to a shared cloud folder could plant a legacy vault. Only upgrade files you created yourself before v1.6.0. Continue?'
    );
    if (!confirmed) {
      return false;
    }

    let rawDecrypted: unknown;
    try {
      rawDecrypted = await this.crypto.decryptLegacy(target, LEGACY_DEFAULT_DEVICE_SECRET);
    } catch (err) {
      if (err instanceof VaultDecryptionError) {
        throw new Error(
          'This vault was not encrypted with the legacy v1.x default key. Enter your personal passphrase instead.'
        );
      }
      throw err;
    }

    if (this.lockGeneration !== gen) {
      return false;
    }

    this.pendingLegacyUpgradePayload = normalizeVaultPayload(rawDecrypted);
    this.host.showLockScreen('upgrade');
    return true;
  }

  /**
   * Creates a new vault or completes a legacy vault upgrade with a user passphrase.
   */
  public async createOrUpgradeVault(
    mode: 'setup' | 'upgrade',
    passphrase: string,
    seedPayload: VaultPayload
  ): Promise<void> {
    const gen = this.lockGeneration;
    return this.runSerialized(async () => {
      if (this.lockGeneration !== gen) {
        throw new Error('Vault setup cancelled because vault was locked.');
      }
      const prevKey = this.host.sessionKey;
      const nextKey = await this.crypto.createSessionKey(passphrase);
      if (this.lockGeneration !== gen) {
        throw new Error('Vault setup cancelled because vault was locked.');
      }

      this.host.sessionKey = nextKey;
      try {
        if (mode === 'upgrade' && this.pendingLegacyUpgradePayload) {
          this.host.applyPayload(this.pendingLegacyUpgradePayload);
          this.pendingLegacyUpgradePayload = null;
          this.pendingImport = null;
        } else {
          this.host.applyPayload(normalizeVaultPayload(seedPayload));
        }
        const snapshot = structuredClone(this.host.getPayloadSnapshot());
        await this.writeSnapshotInternal(snapshot, nextKey, {
          forceCloudWrite: mode === 'upgrade',
          bypassTabConflictCheck: true,
          captureGen: gen,
        });
        if (this.lockGeneration !== gen) {
          this.host.clearSensitiveStateAndDom();
          this.host.sessionKey = null;
          throw new Error('Vault setup cancelled because vault was locked.');
        }
        this.host.renderAll();
        this.host.hideLockScreen();
      } catch (err) {
        this.host.sessionKey = prevKey;
        throw err;
      }
    });
  }

  /**
   * Re-keys the active unlocked vault after verifying the user's current passphrase.
   * Derives a fresh random 16-byte salt and 600,000 PBKDF2 iterations.
   */
  public async rekeyPassphrase(currentPassphrase: string, nextPassphrase: string): Promise<void> {
    const gen = this.lockGeneration;
    return this.runSerialized(async () => {
      const currentKey = this.host.sessionKey;
      if (!currentKey || this.lockGeneration !== gen) {
        throw new Error('Unlock your vault before changing the passphrase.');
      }
      if (!currentPassphrase) {
        throw new Error('Enter your current passphrase to authorize re-keying.');
      }

      const verified = await this.crypto.verifyPassphrase(currentKey, currentPassphrase);
      if (this.lockGeneration !== gen) {
        throw new Error('Passphrase change cancelled because vault was locked.');
      }
      if (!verified) {
        throw new VaultDecryptionError('Current passphrase is incorrect.');
      }

      const nextKey = await this.crypto.createSessionKey(nextPassphrase);
      if (this.lockGeneration !== gen) {
        throw new Error('Passphrase change cancelled because vault was locked.');
      }

      const prevKey = this.host.sessionKey;
      this.host.sessionKey = nextKey;
      try {
        const snapshot = structuredClone(this.host.getPayloadSnapshot());
        await this.writeSnapshotInternal(snapshot, nextKey, {
          forceCloudWrite: false,
          bypassTabConflictCheck: false,
          captureGen: gen,
        });
      } catch (err) {
        if (this.lockGeneration === gen) {
          this.host.sessionKey = prevKey;
        }
        throw err;
      }
    });
  }

  /**
   * Imports an encrypted envelope from a file or cloud folder.
   * NEVER replaces `lastEncryptedEnvelope` or cache before verifying the envelope opens,
   * checking lock generation, passing rollback/empty guards, and rendering cleanly.
   */
  public async importEnvelope(
    rawEnvelope: unknown,
    options: {
      requireConfirmIfNonEmpty?: boolean;
      source: 'file' | 'cloud';
      stamp?: CloudFileStamp | undefined;
      bypassRollbackGuard?: boolean | undefined;
    }
  ): Promise<'applied' | 'needs_unlock' | 'cancelled'> {
    const gen = this.lockGeneration;
    return this.runSerialized(() => this.importEnvelopeInternal(rawEnvelope, options, gen));
  }

  private async importEnvelopeInternal(
    rawEnvelope: unknown,
    options: {
      requireConfirmIfNonEmpty?: boolean;
      source: 'file' | 'cloud';
      stamp?: CloudFileStamp | undefined;
      bypassRollbackGuard?: boolean | undefined;
      fromLocalTab?: boolean | undefined;
    },
    gen: number
  ): Promise<'applied' | 'needs_unlock' | 'cancelled'> {
    if (!this.crypto.isValidEncryptedEnvelope(rawEnvelope)) {
      throw new Error('Invalid .crypsy vault file: malformed encrypted envelope.');
    }

    if (this.lockGeneration !== gen) {
      return 'cancelled';
    }

    const wasNonEmpty = this.host.sessionKey !== null && this.host.hasLocalContent();

    // If unlocked and replacing an existing non-empty vault via file import or cloud folder link, confirm first
    if (options.requireConfirmIfNonEmpty && wasNonEmpty) {
      const promptMsg =
        options.source === 'cloud'
          ? 'This cloud folder already contains an encrypted vault. Linking it will replace your currently loaded notes and boards. Continue?'
          : this.cloud.isConnected()
            ? 'Importing this vault file will replace your currently loaded notes and boards AND overwrite vault.crypsy.json in your connected cloud folder. Continue?'
            : 'Importing this vault file will replace your currently loaded notes and boards. Continue?';
      const ok = this.host.confirmAction(promptMsg);
      if (!ok) {
        return 'cancelled';
      }
    }

    // If currently unlocked, try decrypting with the active session key BEFORE committing anything
    const activeKey = this.host.sessionKey;
    if (activeKey) {
      try {
        const rawDecrypted = await this.crypto.decryptWithKey(rawEnvelope, activeKey);

        // H1: Abort immediately if lock() ran while decrypt was in flight!
        if (this.lockGeneration !== gen || this.host.sessionKey !== activeKey) {
          return 'cancelled';
        }

        const normalized = normalizeVaultPayload(rawDecrypted);

        // H2 / C1 defense: check rollback, version downgrade, and empty-vault replacement guards
        const guard = this.checkIncomingGuards(rawEnvelope, normalized, {
          source: options.source,
          wasNonEmpty: wasNonEmpty && !options.requireConfirmIfNonEmpty,
          bypassRollbackGuard: options.bypassRollbackGuard,
        });
        if (!guard.allowed) {
          if (options.source === 'cloud' && options.stamp) {
            this.cloud.markRemoteFingerprintNotified?.(options.stamp.fingerprint);
            this.setConflict({
              remoteEnvelope: rawEnvelope,
              remoteStamp: options.stamp,
              message: guard.reason,
            });
            this.setSaveStatus({ state: 'conflict', message: guard.reason });
          }
          return 'cancelled';
        }

        if (this.lockGeneration !== gen || this.host.sessionKey !== activeKey) {
          return 'cancelled';
        }

        // M8: Render BEFORE committing to cache or cloud; roll back if rendering throws!
        const prevPayload = structuredClone(this.host.getPayloadSnapshot());
        const prevEnvelope = this.host.lastEncryptedEnvelope;
        this.host.lastEncryptedEnvelope = rawEnvelope;
        this.host.applyPayload(normalized);

        try {
          this.host.renderAll();
          this.host.refreshBoardFromExternal();
        } catch (renderErr) {
          this.host.lastEncryptedEnvelope = prevEnvelope;
          this.host.applyPayload(prevPayload);
          try {
            this.host.renderAll();
          } catch {
            // ignore secondary render failure
          }
          throw new Error(
            `Vault decrypted, but rendering failed: ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`
          );
        }

        if (this.lockGeneration !== gen || this.host.sessionKey !== activeKey) {
          return 'cancelled';
        }

        this.pendingImport = null;
        this.pendingLegacyUpgradePayload = null;
        this.recordAcceptedEnvelopeStats(rawEnvelope);
        const fp = envelopeFingerprint(rawEnvelope);

        if (!options.fromLocalTab) {
          await this.tabs.withExclusiveLock(async () => {
            await this.cache.saveEnvelope(rawEnvelope);
            this.knownCacheFingerprint = fp;
            this.tabs.notifyVaultUpdated(fp, rawEnvelope.revision ?? 0);
          });
        } else {
          this.knownCacheFingerprint = fp;
        }

        this.host.hideLockScreen();

        if (options.source === 'file' && this.cloud.isConnected()) {
          const writeRes = await this.cloud.writeVault(rawEnvelope, { force: true });
          this.handleCloudWriteOutcome(writeRes, rawEnvelope);
        } else if (options.source === 'cloud' && options.stamp) {
          this.cloud.markRemoteStampAccepted(options.stamp);
          this.knownSyncedFingerprint = options.stamp.fingerprint;
          this.saveSyncMetaWithHighWater({
            lastSyncedFingerprint: options.stamp.fingerprint,
            hasUnsyncedLocalChanges: false,
          });
        }

        return 'applied';
      } catch (err) {
        if (!(err instanceof VaultDecryptionError)) {
          throw err;
        }
        if (this.lockGeneration !== gen) {
          return 'cancelled';
        }
        // Decryption failed with current key: keep existing cache untouched!
        if (options.source === 'file') {
          this.pendingImport = { envelope: rawEnvelope, source: 'file' };
          await this.lockInternal({
            flushPending: true,
            errorMsg: this.cloud.isConnected()
              ? 'Imported file uses a different passphrase. Enter its passphrase to open and replace both your local and cloud vaults, or cancel to return to your previous vault.'
              : 'Imported file uses a different passphrase. Enter its passphrase to open, or cancel to return to your previous vault.',
          });
          return 'needs_unlock';
        }
        // Remote cloud envelope re-keyed on another device (or tampered AAD)
        this.pendingImport = {
          envelope: rawEnvelope,
          source: 'cloud',
          stamp: options.stamp,
        };
        await this.lockInternal({
          flushPending: false,
          errorMsg:
            'Vault passphrase changed on another device (or envelope changed). Enter the passphrase to unlock, or cancel to keep your local cached vault.',
        });
        return 'needs_unlock';
      }
    }

    // Currently locked: hold in memory only (do NOT overwrite cache until unlocked!)
    // Also never silently hijack unlock target if local cache has unsynced changes & conflict
    this.pendingImport = {
      envelope: rawEnvelope,
      source: options.source,
      stamp: options.stamp,
      bypassRollbackGuard: options.bypassRollbackGuard,
    };
    this.pendingLegacyUpgradePayload = null;
    const hasPrevious = this.host.lastEncryptedEnvelope !== null;
    const cloudWarning = this.cloud.isConnected()
      ? 'Vault file loaded. Enter its passphrase to decrypt and replace your local vault (and overwrite your connected cloud vault).'
      : 'Vault file loaded. Enter its passphrase to decrypt and replace your local vault.';
    this.host.showLockScreen(
      'unlock',
      options.source === 'file' ? cloudWarning : undefined,
      { canCancelImport: hasPrevious }
    );
    return 'needs_unlock';
  }

  public cancelPendingImport(): void {
    if (!this.pendingImport) return;
    this.pendingImport = null;
    this.pendingLegacyUpgradePayload = null;
    this.host.showLockScreen(this.host.lastEncryptedEnvelope ? 'unlock' : 'setup');
  }

  /**
   * Single-flight encrypted persistence to local cache and (if connected with permission) cloud folder.
   * Preserves `forceCloudWrite` if coalesced while another save is already in flight (M4),
   * and NEVER re-snapshots wiped state after lock() starts (C1).
   */
  public async persist(options: { forceCloudWrite?: boolean } = {}): Promise<void> {
    if (!this.host.sessionKey || this.isLocking) {
      throw new Error('Cannot persist vault while locked without an active session key.');
    }

    if (this.activePersistPromise) {
      this.persistAgainRequested = true;
      if (options.forceCloudWrite) {
        this.persistAgainForceCloudWrite = true;
      }
      await this.activePersistPromise;
      return;
    }

    let forceNext = Boolean(options.forceCloudWrite);
    const run = (async () => {
      try {
        do {
          const forceThisRun = forceNext || this.persistAgainForceCloudWrite;
          this.persistAgainRequested = false;
          this.persistAgainForceCloudWrite = false;
          forceNext = false;

          const activeKey = this.host.sessionKey;
          if (!activeKey || this.isLocking) {
            break;
          }
          const captureGen = this.lockGeneration;
          const snapshot = structuredClone(this.host.getPayloadSnapshot());

          await this.runSerialized(async () => {
            await this.writeSnapshotInternal(snapshot, activeKey, {
              forceCloudWrite: forceThisRun,
              bypassTabConflictCheck: forceThisRun,
              captureGen,
            });
          });
        } while (this.persistAgainRequested && this.host.sessionKey && !this.isLocking);
      } finally {
        this.activePersistPromise = null;
      }
    })();

    this.activePersistPromise = run;
    await run;
  }

  private async writeSnapshotInternal(
    snapshot: VaultPayload,
    sessionKey: VaultSessionKey,
    options: {
      forceCloudWrite: boolean;
      bypassTabConflictCheck: boolean;
      captureGen: number;
      isLockFlush?: boolean | undefined;
    }
  ): Promise<'saved' | 'conflict' | 'needs_permission' | 'aborted' | 'error'> {
    // If a DIFFERENT session unlocked after our capture, abort so we never clobber the new session.
    if (
      this.host.sessionKey !== null &&
      this.host.sessionKey !== sessionKey &&
      this.lockGeneration !== options.captureGen
    ) {
      return 'aborted';
    }

    this.localWriteCounter++;
    this.setSaveStatus({ state: 'saving' });

    const nextRevision =
      Math.max(
        this.highestAcceptedRevision,
        this.host.lastEncryptedEnvelope?.revision ?? 0,
        this.cache.loadSyncMeta().highestAcceptedRevision ?? 0
      ) + 1;

    // Encrypt our immutable pre-captured snapshot using the captured non-extractable key
    const envelope = await this.crypto.encryptWithKey(snapshot, sessionKey, {
      revision: nextRevision,
    });

    // Only abort if a completely different session unlocked during encryption
    if (
      this.host.sessionKey !== null &&
      this.host.sessionKey !== sessionKey &&
      this.lockGeneration !== options.captureGen
    ) {
      return 'aborted';
    }

    return this.tabs.withExclusiveLock(async () => {
      // H6: Cross-tab conflict check inside exclusive lock before overwriting local cache
      if (!options.bypassTabConflictCheck && this.knownCacheFingerprint !== null) {
        const diskCached = await this.cache.loadEnvelope().catch(() => null);
        if (diskCached) {
          const diskFp = envelopeFingerprint(diskCached);
          if (diskFp !== this.knownCacheFingerprint) {
            const msg =
              'Sync conflict: vault was updated in another browser tab. Merge or choose which copy to keep.';
            const stamp: CloudFileStamp = {
              lastModified: Date.now(),
              size: JSON.stringify(diskCached).length,
              fingerprint: diskFp,
            };
            this.setConflict({
              remoteEnvelope: diskCached,
              remoteStamp: stamp,
              message: msg,
            });
            this.setSaveStatus({ state: 'conflict', message: msg });
            return 'conflict';
          }
        }
      }

      try {
        await this.cache.saveEnvelope(envelope);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to save encrypted vault locally.';
        this.setSaveStatus({ state: 'failed', message: msg });
        throw err;
      }

      const localFp = envelopeFingerprint(envelope);
      this.knownCacheFingerprint = localFp;
      this.host.lastEncryptedEnvelope = envelope;
      this.recordAcceptedEnvelopeStats(envelope);
      this.tabs.notifyVaultUpdated(localFp, envelope.revision ?? nextRevision);

      const connStatus = this.cloud.getConnectionStatus();
      if (connStatus === 'connected') {
        // H6: Pass this tab's own `knownSyncedFingerprint` rather than trusting shared localStorage
        const writeRes = await this.cloud.writeVault(envelope, {
          force: options.forceCloudWrite,
          expectedFingerprint: this.knownSyncedFingerprint,
        });
        return this.handleCloudWriteOutcome(writeRes, envelope);
      }
      if (connStatus === 'needs_permission') {
        this.saveSyncMetaWithHighWater({
          lastSyncedFingerprint: this.knownSyncedFingerprint,
          hasUnsyncedLocalChanges: true,
        });
        this.setSaveStatus({
          state: 'needs_permission',
          message: 'Saved locally — reconnect cloud folder to sync.',
        });
        this.host.onCloudStatusChanged('needs_permission');
        return 'needs_permission';
      }

      this.knownSyncedFingerprint = null;
      this.saveSyncMetaWithHighWater({
        lastSyncedFingerprint: null,
        hasUnsyncedLocalChanges: false,
      });
      this.setSaveStatus({ state: 'saved', at: Date.now() });
      return 'saved';
    });
  }

  private handleCloudWriteOutcome(
    writeRes: CloudWriteResult,
    envelope: EncryptedEnvelope
  ): 'saved' | 'conflict' | 'needs_permission' | 'error' {
    const localFp = envelopeFingerprint(envelope);

    if (writeRes.status === 'ok') {
      this.knownSyncedFingerprint = writeRes.stamp.fingerprint;
      this.saveSyncMetaWithHighWater({
        lastSyncedFingerprint: writeRes.stamp.fingerprint,
        hasUnsyncedLocalChanges: false,
      });
      this.setConflict(null);
      this.setSaveStatus({ state: 'saved', at: Date.now() });
      this.host.onCloudStatusChanged('connected');
      return 'saved';
    }

    if (writeRes.status === 'conflict') {
      this.cloud.markRemoteFingerprintNotified?.(writeRes.stamp.fingerprint);
      this.saveSyncMetaWithHighWater({
        lastSyncedFingerprint: this.knownSyncedFingerprint,
        hasUnsyncedLocalChanges: true,
      });
      const msg =
        'Sync conflict: vault.crypsy.json changed on another device. Your local edit is saved in browser cache.';
      this.setConflict({
        remoteEnvelope: writeRes.remoteEnvelope,
        remoteStamp: writeRes.stamp,
        message: msg,
      });
      this.setSaveStatus({ state: 'conflict', message: msg });
      return 'conflict';
    }

    if (writeRes.status === 'no_permission') {
      this.saveSyncMetaWithHighWater({
        lastSyncedFingerprint: this.knownSyncedFingerprint,
        hasUnsyncedLocalChanges: true,
      });
      this.setSaveStatus({
        state: 'needs_permission',
        message: 'Saved locally — cloud folder permission required to sync.',
      });
      this.host.onCloudStatusChanged('needs_permission');
      return 'needs_permission';
    }

    if (writeRes.status === 'unlinked') {
      this.knownSyncedFingerprint = null;
      this.saveSyncMetaWithHighWater({
        lastSyncedFingerprint: null,
        hasUnsyncedLocalChanges: false,
      });
      this.setSaveStatus({ state: 'saved', at: Date.now() });
      this.host.onCloudStatusChanged('unlinked');
      return 'saved';
    }

    // status === 'error'
    this.saveSyncMetaWithHighWater({
      lastSyncedFingerprint: this.knownSyncedFingerprint,
      hasUnsyncedLocalChanges: true,
    });
    this.setSaveStatus({
      state: 'failed',
      message: `Saved locally (${localFp.slice(0, 8)}), cloud sync failed: ${writeRes.message}`,
    });
    return 'error';
  }

  private async handlePeerTabNotice(fingerprint: string, at: number): Promise<void> {
    const latest = await this.cache.loadEnvelope().catch(() => null);
    if (!latest) return;
    const actualFp = envelopeFingerprint(latest);
    if (actualFp === this.knownCacheFingerprint) return;
    const stamp: CloudFileStamp = {
      lastModified: at,
      size: JSON.stringify(latest).length,
      fingerprint: actualFp,
    };
    await this.handleExternalUpdate(latest, stamp, { fromLocalTab: true });
  }

  /**
   * Handles a remote `vault.crypsy.json` (or peer browser tab) change.
   * - Respects active conflicts and unsynced local changes (H3: NEVER silently switches to cloud-wins).
   * - Queues while busy editing or while a local save is active (H4).
   * - Serializes behind the single session operation queue and re-checks guards after async decrypt.
   */
  public async handleExternalUpdate(
    envelope: EncryptedEnvelope,
    stamp: CloudFileStamp,
    options: { fromLocalTab?: boolean | undefined } = {}
  ): Promise<void> {
    if (!this.crypto.isValidEncryptedEnvelope(envelope)) {
      return;
    }

    // H3: If a conflict is already active, NEVER auto-apply or clear the conflict banner!
    if (this.pendingConflict !== null) {
      this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
      this.setConflict({
        remoteEnvelope: envelope,
        remoteStamp: stamp,
        message: this.pendingConflict.message,
      });
      return;
    }

    // H3: If local cache has unsynced edits (whether unlocked OR locked!), raise conflict instead of clobbering!
    const syncMeta = this.cache.loadSyncMeta();
    if (syncMeta.hasUnsyncedLocalChanges && !options.fromLocalTab) {
      if (stamp.fingerprint === this.knownSyncedFingerprint) {
        return;
      }
      this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
      const msg =
        'Sync conflict: another device updated vault.crypsy.json while you have unsynced local changes.';
      this.setConflict({
        remoteEnvelope: envelope,
        remoteStamp: stamp,
        message: msg,
      });
      this.setSaveStatus({ state: 'conflict', message: msg });
      return;
    }

    if (this.host.isBusyEditing() || this.activePersistPromise || this.isLocking) {
      this.pendingExternalUpdate = {
        envelope,
        stamp,
        fromLocalTab: options.fromLocalTab,
      };
      return;
    }

    const gen = this.lockGeneration;
    await this.runSerialized(() =>
      this.applyExternalUpdateInternal(envelope, stamp, gen, options.fromLocalTab)
    );
  }

  /**
   * Applies any queued remote update once the user finishes editing a note, composer, or board.
   */
  public async flushPendingExternalUpdate(): Promise<void> {
    if (
      !this.pendingExternalUpdate ||
      this.host.isBusyEditing() ||
      this.activePersistPromise ||
      this.isLocking
    ) {
      return;
    }
    const gen = this.lockGeneration;
    await this.runSerialized(async () => {
      if (
        !this.pendingExternalUpdate ||
        this.host.isBusyEditing() ||
        this.activePersistPromise ||
        this.isLocking ||
        this.lockGeneration !== gen
      ) {
        return;
      }
      const next = this.pendingExternalUpdate;
      this.pendingExternalUpdate = null;

      if (this.pendingConflict !== null) {
        this.cloud.markRemoteFingerprintNotified?.(next.stamp.fingerprint);
        this.setConflict({
          remoteEnvelope: next.envelope,
          remoteStamp: next.stamp,
          message: this.pendingConflict.message,
        });
        return;
      }

      const syncMeta = this.cache.loadSyncMeta();
      if (syncMeta.hasUnsyncedLocalChanges && this.host.sessionKey && !next.fromLocalTab) {
        this.cloud.markRemoteFingerprintNotified?.(next.stamp.fingerprint);
        const msg =
          'Sync conflict: another device updated vault.crypsy.json while you were editing.';
        this.setConflict({
          remoteEnvelope: next.envelope,
          remoteStamp: next.stamp,
          message: msg,
        });
        this.setSaveStatus({ state: 'conflict', message: msg });
        return;
      }

      await this.applyExternalUpdateInternal(next.envelope, next.stamp, gen, next.fromLocalTab);
    });
  }

  private async applyExternalUpdateInternal(
    envelope: EncryptedEnvelope,
    stamp: CloudFileStamp,
    gen: number,
    fromLocalTab = false
  ): Promise<void> {
    if (this.lockGeneration !== gen || this.isLocking) {
      return;
    }

    if (this.pendingConflict !== null) {
      this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
      this.setConflict({
        remoteEnvelope: envelope,
        remoteStamp: stamp,
        message: this.pendingConflict.message,
      });
      return;
    }

    const syncMeta = this.cache.loadSyncMeta();
    if (syncMeta.hasUnsyncedLocalChanges && !fromLocalTab) {
      if (stamp.fingerprint === this.knownSyncedFingerprint) return;
      this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
      const msg =
        'Sync conflict: another device updated vault.crypsy.json while you have unsynced local changes.';
      this.setConflict({
        remoteEnvelope: envelope,
        remoteStamp: stamp,
        message: msg,
      });
      this.setSaveStatus({ state: 'conflict', message: msg });
      return;
    }

    if (this.host.isBusyEditing()) {
      this.pendingExternalUpdate = { envelope, stamp, fromLocalTab };
      return;
    }

    const activeKey = this.host.sessionKey;
    const writeCounterBefore = this.localWriteCounter;

    // If unlocked, pre-decrypt and re-verify busy/lock/conflict state AFTER decrypt before mutating anything!
    if (activeKey) {
      const wasNonEmpty = this.host.hasLocalContent();
      let rawDecrypted: unknown;
      try {
        rawDecrypted = await this.crypto.decryptWithKey(envelope, activeKey);
      } catch (err) {
        if (this.lockGeneration !== gen) return;
        if (!(err instanceof VaultDecryptionError)) {
          throw err;
        }
        // Remote vault passphrase changed (or envelope tampered) -> hold pending & lock without clobbering cache
        this.pendingImport = { envelope, source: 'cloud', stamp };
        this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
        await this.lockInternal({
          flushPending: false,
          errorMsg:
            'Vault passphrase changed on another device. Enter the new passphrase to unlock, or cancel to keep your local cached vault.',
        });
        return;
      }

      // H1 & H4: Re-check lock generation, active edits, local writes, and conflicts AFTER async decrypt!
      if (this.lockGeneration !== gen || this.host.sessionKey !== activeKey || this.isLocking) {
        return;
      }
      const currentConflict = this.getPendingConflict();
      if (currentConflict !== null) {
        this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
        this.setConflict({
          remoteEnvelope: envelope,
          remoteStamp: stamp,
          message: currentConflict.message,
        });
        return;
      }
      if (
        this.localWriteCounter !== writeCounterBefore ||
        (!fromLocalTab && this.cache.loadSyncMeta().hasUnsyncedLocalChanges)
      ) {
        this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
        const msg =
          'Sync conflict: another device updated vault.crypsy.json while you saved a local edit.';
        this.setConflict({
          remoteEnvelope: envelope,
          remoteStamp: stamp,
          message: msg,
        });
        this.setSaveStatus({ state: 'conflict', message: msg });
        return;
      }
      if (this.host.isBusyEditing()) {
        this.pendingExternalUpdate = { envelope, stamp, fromLocalTab };
        return;
      }

      const normalized = normalizeVaultPayload(rawDecrypted);
      const guard = this.checkIncomingGuards(envelope, normalized, {
        source: 'cloud',
        wasNonEmpty,
      });
      if (!guard.allowed) {
        this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
        this.setConflict({
          remoteEnvelope: envelope,
          remoteStamp: stamp,
          message: guard.reason,
        });
        this.setSaveStatus({ state: 'conflict', message: guard.reason });
        return;
      }

      // M8: Render BEFORE committing cache!
      const prevPayload = structuredClone(this.host.getPayloadSnapshot());
      const prevEnvelope = this.host.lastEncryptedEnvelope;
      this.host.lastEncryptedEnvelope = envelope;
      this.host.applyPayload(normalized);
      try {
        this.host.renderAll();
        this.host.refreshBoardFromExternal();
      } catch (renderErr) {
        this.host.lastEncryptedEnvelope = prevEnvelope;
        this.host.applyPayload(prevPayload);
        try {
          this.host.renderAll();
        } catch {
          // ignore
        }
        throw renderErr;
      }

      if (this.lockGeneration !== gen || this.host.sessionKey !== activeKey) {
        return;
      }

      this.pendingImport = null;
      this.pendingLegacyUpgradePayload = null;
      this.recordAcceptedEnvelopeStats(envelope);
      const fp = envelopeFingerprint(envelope);

      if (!fromLocalTab) {
        await this.tabs.withExclusiveLock(async () => {
          await this.cache.saveEnvelope(envelope);
          this.knownCacheFingerprint = fp;
          this.tabs.notifyVaultUpdated(fp, envelope.revision ?? 0);
        });
        this.cloud.markRemoteStampAccepted(stamp);
        this.knownSyncedFingerprint = stamp.fingerprint;
        this.saveSyncMetaWithHighWater({
          lastSyncedFingerprint: stamp.fingerprint,
          hasUnsyncedLocalChanges: false,
        });
      } else {
        this.knownCacheFingerprint = fp;
        const latestMeta = this.cache.loadSyncMeta();
        this.knownSyncedFingerprint = latestMeta.lastSyncedFingerprint;
      }

      this.setConflict(null);
      this.setSaveStatus({ state: 'saved', at: Date.now() });
      if (!fromLocalTab) {
        this.host.onCloudStatusChanged('connected');
      }
      return;
    }

    // Locked without unsynced local changes -> hold as pending import (do NOT overwrite local cache)
    if (!fromLocalTab) {
      this.cloud.markRemoteFingerprintNotified?.(stamp.fingerprint);
    }
    await this.importEnvelopeInternal(envelope, { source: 'cloud', stamp, fromLocalTab }, gen);
  }

  /**
   * Reconnects a saved cloud folder handle without discarding unsynced local work.
   */
  public async resumeCloudSync(): Promise<{
    reconnected: boolean;
    error?: string;
  }> {
    const gen = this.lockGeneration;
    return this.runSerialized(async () => {
      const granted = await this.cloud.reconnectSavedHandle();
      if (!granted) {
        this.host.onCloudStatusChanged('needs_permission');
        return { reconnected: false };
      }

      this.host.onCloudStatusChanged('connected');
      const readRes = await this.cloud.readVault();

      if (readRes.status === 'corrupt' || readRes.status === 'error') {
        const msg = readRes.message;
        this.setSaveStatus({ state: 'failed', message: msg });
        return { reconnected: true, error: msg };
      }

      const syncMeta = this.cache.loadSyncMeta();
      const localEnvelope = this.host.lastEncryptedEnvelope ?? (await this.cache.loadEnvelope());
      const localFp = localEnvelope ? envelopeFingerprint(localEnvelope) : null;

      if (readRes.status === 'not_found') {
        if (this.host.sessionKey && this.lockGeneration === gen) {
          const snapshot = structuredClone(this.host.getPayloadSnapshot());
          await this.writeSnapshotInternal(snapshot, this.host.sessionKey, {
            forceCloudWrite: true,
            bypassTabConflictCheck: true,
            captureGen: gen,
          });
        } else if (localEnvelope) {
          const writeRes = await this.cloud.writeVault(localEnvelope, { force: true });
          this.handleCloudWriteOutcome(writeRes, localEnvelope);
        }
        return { reconnected: true };
      }

      if (readRes.status !== 'ok') {
        return { reconnected: true };
      }

      const cloudFp = readRes.stamp.fingerprint;

      // If local cache has unsynced work and differs from cloud, NEVER discard local work!
      if (localEnvelope && syncMeta.hasUnsyncedLocalChanges && localFp !== cloudFp) {
        if (syncMeta.lastSyncedFingerprint === cloudFp) {
          // Cloud hasn't moved since our last sync -> safely push local envelope to cloud
          this.cloud.markRemoteStampAccepted(readRes.stamp);
          const writeRes = await this.cloud.writeVault(localEnvelope, {
            expectedFingerprint: cloudFp,
          });
          this.handleCloudWriteOutcome(writeRes, localEnvelope);
          return { reconnected: true };
        }

        // Both local and cloud diverged -> surface conflict
        this.cloud.markRemoteFingerprintNotified?.(cloudFp);
        const msg =
          'Sync conflict: both this device and your cloud folder changed while disconnected.';
        this.setConflict({
          remoteEnvelope: readRes.envelope,
          remoteStamp: readRes.stamp,
          message: msg,
        });
        this.setSaveStatus({ state: 'conflict', message: msg });
        return { reconnected: true };
      }

      // No unsynced local changes -> safe to load cloud envelope
      if (localFp !== cloudFp) {
        this.cloud.markRemoteFingerprintNotified?.(cloudFp);
        const outcome = await this.importEnvelopeInternal(
          readRes.envelope,
          { source: 'cloud', stamp: readRes.stamp },
          gen
        );
        if (outcome === 'applied') {
          this.setSaveStatus({ state: 'saved', at: Date.now() });
        }
      } else {
        this.cloud.markRemoteStampAccepted(readRes.stamp);
        this.knownSyncedFingerprint = cloudFp;
        this.saveSyncMetaWithHighWater({
          lastSyncedFingerprint: cloudFp,
          hasUnsyncedLocalChanges: false,
        });
        this.setSaveStatus({ state: 'saved', at: Date.now() });
      }

      return { reconnected: true };
    });
  }

  /**
   * Resolves an active sync conflict via non-destructive merge, keeping local, or loading remote.
   * Serialized on the session queue so in-flight writes never drop `forceCloudWrite` (M4)
   * and the conflict banner is cleared ONLY when resolution actually succeeds.
   */
  public async resolveConflict(choice: 'merge' | 'keep_local' | 'keep_remote'): Promise<void> {
    const gen = this.lockGeneration;
    return this.runSerialized(async () => {
      if (this.lockGeneration !== gen) return;
      const conflict = this.pendingConflict;
      if (!conflict) return;

      if (choice === 'keep_local') {
        const activeKey = this.host.sessionKey;
        if (!activeKey) {
          throw new Error('Unlock your vault before overwriting cloud with local changes.');
        }
        this.cloud.markRemoteStampAccepted(conflict.remoteStamp);
        this.knownSyncedFingerprint = conflict.remoteStamp.fingerprint;
        const snapshot = structuredClone(this.host.getPayloadSnapshot());
        const outcome = await this.writeSnapshotInternal(snapshot, activeKey, {
          forceCloudWrite: true,
          bypassTabConflictCheck: true,
          captureGen: gen,
        });
        if (outcome === 'saved') {
          this.setConflict(null);
        }
        return;
      }

      if (choice === 'keep_remote') {
        const outcome = await this.importEnvelopeInternal(
          conflict.remoteEnvelope,
          {
            source: 'cloud',
            stamp: conflict.remoteStamp,
            bypassRollbackGuard: true,
          },
          gen
        );
        if (outcome === 'applied') {
          this.setConflict(null);
          this.setSaveStatus({ state: 'saved', at: Date.now() });
        }
        return;
      }

      // choice === 'merge'
      const activeKey = this.host.sessionKey;
      if (!activeKey) {
        throw new Error('Unlock your vault before merging conflicting changes.');
      }
      const rawRemote = await this.crypto.decryptWithKey(conflict.remoteEnvelope, activeKey);
      if (this.lockGeneration !== gen || this.host.sessionKey !== activeKey) {
        return;
      }
      const remotePayload = normalizeVaultPayload(rawRemote);
      const localPayload = normalizeVaultPayload(this.host.getPayloadSnapshot());
      const merged = mergeVaultPayloads(localPayload, remotePayload);

      this.host.applyPayload(merged);
      this.host.renderAll();
      this.host.refreshBoardFromExternal();
      this.cloud.markRemoteStampAccepted(conflict.remoteStamp);
      this.knownSyncedFingerprint = conflict.remoteStamp.fingerprint;
      const outcome = await this.writeSnapshotInternal(structuredClone(merged), activeKey, {
        forceCloudWrite: true,
        bypassTabConflictCheck: true,
        captureGen: gen,
      });
      if (outcome === 'saved') {
        this.setConflict(null);
      }
    });
  }

  /**
   * Locks the vault safely (fixes C1, H1, M5):
   * 1. Immediately bumps `lockGeneration` so any in-flight decrypt/import/unlock cannot undo the lock.
   * 2. Commits open drafts silently into memory and snapshots immutable plaintext BEFORE clearing anything.
   * 3. Clears session key, in-memory state, and DOM immediately, and displays the lock screen right away.
   * 4. Flushes the pre-captured snapshot (or any already-snapshotted in-flight save) using ONLY local
   *    closure references — NEVER re-reading wiped state and NEVER aborting an already-encrypted write
   *    when `timeoutMs` elapses.
   */
  public async lock(options: {
    flushPending?: boolean;
    errorMsg?: string;
    timeoutMs?: number;
  } = {}): Promise<void> {
    await this.lockInternal(options);
  }

  private async lockInternal(options: {
    flushPending?: boolean;
    errorMsg?: string;
    timeoutMs?: number;
  } = {}): Promise<void> {
    const flushPending = Boolean(options.flushPending);
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_FLUSH_TIMEOUT_MS;
    const myGen = ++this.lockGeneration;
    this.isLocking = true;

    let lockWarning = options.errorMsg;
    const capturedKey = this.host.sessionKey;
    const hadQueuedPersist = this.persistAgainRequested;
    const hadQueuedForce = this.persistAgainForceCloudWrite;
    const existingPersist = this.activePersistPromise;

    // Prevent any running persist() loop from starting another writeOnce on post-wipe state!
    this.persistAgainRequested = false;
    this.persistAgainForceCloudWrite = false;

    let preWipeSnapshot: VaultPayload | null = null;
    if (flushPending && capturedKey) {
      const committedDraft = this.host.commitOpenDrafts();
      if (committedDraft || hadQueuedPersist) {
        // C1: Snapshot BEFORE wiping state!
        preWipeSnapshot = structuredClone(this.host.getPayloadSnapshot());
      }
    }

    // Immediately drop active session key, wipe decrypted state & DOM, and show lock overlay
    this.host.sessionKey = null;
    this.pendingLegacyUpgradePayload = null;
    this.pendingExternalUpdate = null;
    this.host.clearSensitiveStateAndDom();

    const targetMode = this.getActiveUnlockTargetEnvelope() ? 'unlock' : 'setup';
    this.host.showLockScreen(targetMode, lockWarning, {
      canCancelImport: this.pendingImport !== null && this.host.lastEncryptedEnvelope !== null,
    });

    let flushPromise: Promise<void> | null = null;
    if (flushPending && capturedKey && (preWipeSnapshot !== null || existingPersist !== null)) {
      const snapshotToEncrypt = preWipeSnapshot;
      const keyForFlush = capturedKey;

      if (snapshotToEncrypt !== null) {
        // Enqueue the pre-wipe snapshot AFTER any currently in-flight write completes.
        // Uses ONLY captured immutable snapshot + captured key; NEVER reads live wiped state!
        flushPromise = this.runSerialized(async () => {
          try {
            await this.writeSnapshotInternal(snapshotToEncrypt, keyForFlush, {
              forceCloudWrite: hadQueuedForce,
              bypassTabConflictCheck: hadQueuedForce,
              captureGen: myGen,
              isLockFlush: true,
            });
          } catch (err) {
            lockWarning =
              lockWarning ??
              `Vault locked, but saving your latest draft failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
      } else if (existingPersist !== null) {
        flushPromise = existingPersist.catch(() => {
          // status already surfaced
        });
      }
    }

    this.isLocking = false;

    if (flushPromise) {
      let timedOut = false;
      let timerId: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        flushPromise,
        new Promise<void>((resolve) => {
          timerId = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      if (timerId !== null) {
        clearTimeout(timerId);
      }

      // Only update lock screen message if user hasn't unlocked again in the meantime
      if (this.lockGeneration === myGen && this.host.sessionKey === null) {
        const canCancelImport =
          this.pendingImport !== null && this.host.lastEncryptedEnvelope !== null;
        if (timedOut && !lockWarning) {
          this.host.showLockScreen(
            this.getActiveUnlockTargetEnvelope() ? 'unlock' : 'setup',
            'Vault locked; background save is still completing. Verify your latest edit after unlocking.',
            { canCancelImport }
          );
        } else if (lockWarning && lockWarning !== options.errorMsg) {
          this.host.showLockScreen(
            this.getActiveUnlockTargetEnvelope() ? 'unlock' : 'setup',
            lockWarning,
            { canCancelImport }
          );
        }
      }
    }
  }
}
