/**
 * Crypsy — Stateful Vault Load, Save, Sync, Conflict & Lock Session Engine
 *
 * Designed with injected cache, cloud, and crypto adapters so every stateful
 * failure mode (load validation, legacy key gating, sync conflicts, permission
 * loss, cache aborts, lock draft-flushing, and unlock error isolation) is
 * directly unit-testable.
 */

import type {
  CloudConnectionStatus,
  CloudFileStamp,
  CloudReadResult,
  CloudWriteResult,
  EncryptedEnvelope,
  VaultPayload,
  VaultSaveStatus,
} from '../types';
import type { VaultCacheStorage } from './cache';
import {
  VaultDecryptionError,
  decryptPayload,
  encryptPayload,
  envelopeFingerprint,
  isValidEncryptedEnvelope,
} from './crypto';
import { mergeVaultPayloads, normalizeVaultPayload } from './payload';

export const LEGACY_DEFAULT_DEVICE_SECRET = 'crypsy-local-device-default-key-v1';

export interface VaultCryptoAdapter {
  encryptPayload: typeof encryptPayload;
  decryptPayload: typeof decryptPayload;
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
  reconnectSavedHandle: () => Promise<boolean>;
}

export interface VaultSessionState {
  passphrase: string | null;
  lastEncryptedEnvelope: EncryptedEnvelope | null;
  getPayloadSnapshot: () => VaultPayload;
  applyPayload: (payload: VaultPayload) => void;
  hasLocalContent: () => boolean;
  isBusyEditing: () => boolean;
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
}

const DEFAULT_LOCK_FLUSH_TIMEOUT_MS = 5000;

export class VaultSession {
  private readonly cache: VaultCacheStorage;
  private readonly cloud: VaultCloudAdapter;
  private readonly crypto: VaultCryptoAdapter;
  private readonly host: VaultSessionState;

  private activePersistPromise: Promise<void> | null = null;
  private persistAgainRequested = false;
  private pendingImportEnvelope: EncryptedEnvelope | null = null;
  private pendingLegacyUpgradePayload: VaultPayload | null = null;
  private pendingExternalUpdate: PendingExternalUpdate | null = null;
  private pendingConflict: PendingSyncConflict | null = null;
  private saveStatus: VaultSaveStatus = { state: 'idle' };

  constructor(deps: {
    cache: VaultCacheStorage;
    cloud: VaultCloudAdapter;
    crypto?: VaultCryptoAdapter;
    host: VaultSessionState;
  }) {
    this.cache = deps.cache;
    this.cloud = deps.cloud;
    this.crypto = deps.crypto ?? {
      encryptPayload,
      decryptPayload,
      isValidEncryptedEnvelope,
    };
    this.host = deps.host;
  }

  public getSaveStatus(): VaultSaveStatus {
    return this.saveStatus;
  }

  public getPendingConflict(): PendingSyncConflict | null {
    return this.pendingConflict;
  }

  public hasPendingImport(): boolean {
    return this.pendingImportEnvelope !== null;
  }

  public getPendingExternalUpdate(): PendingExternalUpdate | null {
    return this.pendingExternalUpdate;
  }

  public getActiveUnlockTargetEnvelope(): EncryptedEnvelope | null {
    return this.pendingImportEnvelope ?? this.host.lastEncryptedEnvelope;
  }

  private setSaveStatus(status: VaultSaveStatus): void {
    this.saveStatus = status;
    this.host.onSaveStatusChanged(status);
  }

  private setConflict(conflict: PendingSyncConflict | null): void {
    this.pendingConflict = conflict;
    this.host.onConflictChanged(conflict);
  }

  /**
   * Startup initialization: loads cloud or local cache without overwriting corrupt files
   * and without silently attempting the hardcoded legacy secret.
   */
  public async init(cloudStatus: CloudConnectionStatus): Promise<void> {
    const cachedEnvelope = await this.cache.loadEnvelope();
    const syncMeta = this.cache.loadSyncMeta();

    if (cloudStatus === 'connected') {
      const readRes = await this.cloud.readVault();
      if (readRes.status === 'corrupt') {
        if (cachedEnvelope) {
          this.host.lastEncryptedEnvelope = cachedEnvelope;
          this.host.showLockScreen('unlock', readRes.message);
        } else {
          this.host.showLockScreen('unlock', readRes.message);
        }
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

        this.host.lastEncryptedEnvelope = readRes.envelope;
        this.cloud.markRemoteStampAccepted(readRes.stamp);
        try {
          await this.cache.saveEnvelope(readRes.envelope);
          this.cache.saveSyncMeta({
            lastSyncedFingerprint: cloudFp,
            hasUnsyncedLocalChanges: false,
          });
        } catch {
          // Cache failure during startup should not block unlocking the cloud envelope
        }
        this.host.showLockScreen('unlock');
        return;
      }
      if (readRes.status === 'error') {
        if (cachedEnvelope) {
          this.host.lastEncryptedEnvelope = cachedEnvelope;
          this.host.showLockScreen('unlock', `Cloud folder error: ${readRes.message}`);
          return;
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
   * Unlocks the active envelope (or a pending imported envelope).
   * Separates decryption failures (`VaultDecryptionError`) from post-decrypt errors,
   * normalizes the payload at the boundary, and commits to cache ONLY after success.
   */
  public async unlockWithPassphrase(passphrase: string): Promise<void> {
    const target = this.pendingImportEnvelope ?? this.host.lastEncryptedEnvelope ?? (await this.cache.loadEnvelope());
    if (!target) {
      throw new Error('No encrypted vault found to unlock.');
    }
    if (!this.crypto.isValidEncryptedEnvelope(target)) {
      throw new Error('Encrypted vault envelope is malformed.');
    }

    // Step 1: Decrypt ONLY (throws VaultDecryptionError on wrong passphrase)
    const rawDecrypted = await this.crypto.decryptPayload(target, passphrase);

    // Step 2: Validate & normalize payload before mutating state
    const normalized = normalizeVaultPayload(rawDecrypted);

    // Step 3: Commit state & cache atomically after decrypt + normalize succeed
    const wasImport = this.pendingImportEnvelope !== null;
    this.pendingImportEnvelope = null;
    this.pendingLegacyUpgradePayload = null;
    this.host.passphrase = passphrase;
    this.host.lastEncryptedEnvelope = target;
    this.host.applyPayload(normalized);

    if (wasImport) {
      try {
        await this.cache.saveEnvelope(target);
      } catch (err) {
        this.setSaveStatus({
          state: 'failed',
          message: err instanceof Error ? err.message : 'Failed to save imported vault locally.',
        });
      }
      if (this.cloud.isConnected()) {
        const writeRes = await this.cloud.writeVault(target, { force: true });
        this.handleCloudWriteOutcome(writeRes, target);
      }
    }

    // Step 4: Render UI cleanly (if rendering fails, do not report wrong passphrase!)
    try {
      this.host.renderAll();
      this.host.refreshBoardFromExternal();
    } catch (renderErr) {
      // Roll back unlocked state so sensitive data is not left behind lock screen
      this.host.clearSensitiveStateAndDom();
      this.host.passphrase = null;
      throw new Error(
        `Vault decrypted, but rendering failed: ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`
      );
    }

    // If local cache had unsynced changes and cloud is connected without conflict, push now
    const syncMeta = this.cache.loadSyncMeta();
    if (syncMeta.hasUnsyncedLocalChanges && this.cloud.isConnected() && !this.pendingConflict) {
      void this.persist();
    }
  }

  /**
   * Explicitly gated legacy v1.x default-key migration.
   * Never runs automatically; requires explicit user confirmation.
   */
  public async tryBeginLegacyUpgrade(): Promise<boolean> {
    const target = this.pendingImportEnvelope ?? this.host.lastEncryptedEnvelope;
    if (!target || !this.crypto.isValidEncryptedEnvelope(target)) {
      throw new Error('No valid vault file available for legacy migration.');
    }

    const confirmed = this.host.confirmAction(
      'Legacy v1.x vaults used a publicly known default key and cannot verify authorship. Only upgrade files you created yourself. Continue?'
    );
    if (!confirmed) {
      return false;
    }

    let rawDecrypted: unknown;
    try {
      rawDecrypted = await this.crypto.decryptPayload(target, LEGACY_DEFAULT_DEVICE_SECRET);
    } catch (err) {
      if (err instanceof VaultDecryptionError) {
        throw new Error(
          'This vault was not encrypted with the legacy v1.x default key. Enter your personal passphrase instead.'
        );
      }
      throw err;
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
    const prevPassphrase = this.host.passphrase;
    this.host.passphrase = passphrase;
    try {
      if (mode === 'upgrade' && this.pendingLegacyUpgradePayload) {
        this.host.applyPayload(this.pendingLegacyUpgradePayload);
        this.pendingLegacyUpgradePayload = null;
        this.pendingImportEnvelope = null;
      } else {
        this.host.applyPayload(normalizeVaultPayload(seedPayload));
      }
      await this.persist({ forceCloudWrite: mode === 'upgrade' });
      this.host.renderAll();
    } catch (err) {
      this.host.passphrase = prevPassphrase;
      throw err;
    }
  }

  /**
   * Imports an encrypted envelope from a file or cloud folder.
   * NEVER replaces `lastEncryptedEnvelope` or cache before verifying the envelope opens.
   */
  public async importEnvelope(
    rawEnvelope: unknown,
    options: { requireConfirmIfNonEmpty?: boolean; source: 'file' | 'cloud' }
  ): Promise<'applied' | 'needs_unlock' | 'cancelled'> {
    if (!this.crypto.isValidEncryptedEnvelope(rawEnvelope)) {
      throw new Error('Invalid .crypsy vault file: malformed encrypted envelope.');
    }

    // If unlocked and replacing an existing non-empty vault via file import, confirm first
    if (
      options.requireConfirmIfNonEmpty &&
      this.host.passphrase &&
      this.host.hasLocalContent()
    ) {
      const ok = this.host.confirmAction(
        'Importing this vault file will replace your currently loaded notes and boards. Continue?'
      );
      if (!ok) {
        return 'cancelled';
      }
    }

    // If currently unlocked, try decrypting with the active passphrase BEFORE committing anything
    if (this.host.passphrase) {
      try {
        const rawDecrypted = await this.crypto.decryptPayload(rawEnvelope, this.host.passphrase);
        const normalized = normalizeVaultPayload(rawDecrypted);
        this.pendingImportEnvelope = null;
        this.pendingLegacyUpgradePayload = null;
        this.host.lastEncryptedEnvelope = rawEnvelope;
        this.host.applyPayload(normalized);
        await this.cache.saveEnvelope(rawEnvelope);
        this.host.hideLockScreen();
        this.host.renderAll();
        this.host.refreshBoardFromExternal();
        if (options.source === 'file' && this.cloud.isConnected()) {
          const writeRes = await this.cloud.writeVault(rawEnvelope, { force: true });
          this.handleCloudWriteOutcome(writeRes, rawEnvelope);
        }
        return 'applied';
      } catch (err) {
        if (!(err instanceof VaultDecryptionError)) {
          throw err;
        }
        // Decryption failed with current passphrase: keep existing cache untouched!
        if (options.source === 'file') {
          this.pendingImportEnvelope = rawEnvelope;
          await this.lock({
            flushPending: true,
            errorMsg:
              'Imported file uses a different passphrase. Enter its passphrase to open, or cancel to return to your previous vault.',
          });
          return 'needs_unlock';
        }
        // Remote cloud envelope re-keyed on another device
        this.pendingImportEnvelope = rawEnvelope;
        await this.lock({
          flushPending: false,
          errorMsg:
            'Vault passphrase changed on another device. Enter the new passphrase to unlock.',
        });
        return 'needs_unlock';
      }
    }

    // Currently locked: hold in memory only (do NOT overwrite cache until unlocked!)
    this.pendingImportEnvelope = rawEnvelope;
    this.pendingLegacyUpgradePayload = null;
    const hasPrevious = this.host.lastEncryptedEnvelope !== null;
    this.host.showLockScreen(
      'unlock',
      options.source === 'file'
        ? 'Vault file loaded. Enter its passphrase to decrypt and replace your local vault.'
        : undefined,
      { canCancelImport: hasPrevious && options.source === 'file' }
    );
    return 'needs_unlock';
  }

  public cancelPendingImport(): void {
    if (!this.pendingImportEnvelope) return;
    this.pendingImportEnvelope = null;
    this.pendingLegacyUpgradePayload = null;
    this.host.showLockScreen(this.host.lastEncryptedEnvelope ? 'unlock' : 'setup');
  }

  /**
   * Single-flight encrypted persistence to local cache and (if connected with permission) cloud folder.
   * Never hangs on cache failure; surfaces clear saving/saved/failed/conflict/needs_permission status.
   */
  public async persist(options: { forceCloudWrite?: boolean } = {}): Promise<void> {
    if (!this.host.passphrase) {
      throw new Error('Cannot persist vault while locked without a passphrase.');
    }

    if (this.activePersistPromise) {
      this.persistAgainRequested = true;
      await this.activePersistPromise;
      return;
    }

    let forceNext = Boolean(options.forceCloudWrite);
    const run = (async () => {
      try {
        do {
          this.persistAgainRequested = false;
          await this.writeOnce(forceNext);
          forceNext = false;
        } while (this.persistAgainRequested && this.host.passphrase);
      } finally {
        this.activePersistPromise = null;
      }
    })();

    this.activePersistPromise = run;
    await run;
  }

  private async writeOnce(forceCloudWrite: boolean): Promise<void> {
    const passphrase = this.host.passphrase;
    if (!passphrase) {
      throw new Error('Cannot persist vault while locked without a passphrase.');
    }

    this.setSaveStatus({ state: 'saving' });

    const payload = structuredClone(this.host.getPayloadSnapshot());
    const nextRevision = (this.host.lastEncryptedEnvelope?.revision ?? 0) + 1;
    const envelope = await this.crypto.encryptPayload(payload, passphrase, {
      revision: nextRevision,
    });

    if (this.host.passphrase !== passphrase) {
      return;
    }

    try {
      await this.cache.saveEnvelope(envelope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save encrypted vault locally.';
      this.setSaveStatus({ state: 'failed', message: msg });
      throw err;
    }

    this.host.lastEncryptedEnvelope = envelope;
    const syncMeta = this.cache.loadSyncMeta();

    const connStatus = this.cloud.getConnectionStatus();
    if (connStatus === 'connected') {
      const writeRes = await this.cloud.writeVault(envelope, {
        force: forceCloudWrite,
        expectedFingerprint: syncMeta.lastSyncedFingerprint,
      });
      this.handleCloudWriteOutcome(writeRes, envelope);
    } else if (connStatus === 'needs_permission') {
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: syncMeta.lastSyncedFingerprint,
        hasUnsyncedLocalChanges: true,
      });
      this.setSaveStatus({
        state: 'needs_permission',
        message: 'Saved locally — reconnect cloud folder to sync.',
      });
      this.host.onCloudStatusChanged('needs_permission');
    } else {
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: null,
        hasUnsyncedLocalChanges: false,
      });
      this.setSaveStatus({ state: 'saved', at: Date.now() });
    }
  }

  private handleCloudWriteOutcome(writeRes: CloudWriteResult, envelope: EncryptedEnvelope): void {
    const syncMeta = this.cache.loadSyncMeta();
    const localFp = envelopeFingerprint(envelope);

    if (writeRes.status === 'ok') {
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: writeRes.stamp.fingerprint,
        hasUnsyncedLocalChanges: false,
      });
      this.setConflict(null);
      this.setSaveStatus({ state: 'saved', at: Date.now() });
      this.host.onCloudStatusChanged('connected');
      return;
    }

    if (writeRes.status === 'conflict') {
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: syncMeta.lastSyncedFingerprint,
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
      return;
    }

    if (writeRes.status === 'no_permission') {
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: syncMeta.lastSyncedFingerprint,
        hasUnsyncedLocalChanges: true,
      });
      this.setSaveStatus({
        state: 'needs_permission',
        message: 'Saved locally — cloud folder permission required to sync.',
      });
      this.host.onCloudStatusChanged('needs_permission');
      return;
    }

    if (writeRes.status === 'unlinked') {
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: null,
        hasUnsyncedLocalChanges: false,
      });
      this.setSaveStatus({ state: 'saved', at: Date.now() });
      this.host.onCloudStatusChanged('unlinked');
      return;
    }

    // status === 'error'
    this.cache.saveSyncMeta({
      lastSyncedFingerprint: syncMeta.lastSyncedFingerprint,
      hasUnsyncedLocalChanges: true,
    });
    this.setSaveStatus({
      state: 'failed',
      message: `Saved locally (${localFp.slice(0, 8)}), cloud sync failed: ${writeRes.message}`,
    });
  }

  /**
   * Handles a remote `vault.crypsy.json` change detected by polling.
   * Queues the update when the user is actively editing instead of dropping it.
   */
  public async handleExternalUpdate(
    envelope: EncryptedEnvelope,
    stamp: CloudFileStamp
  ): Promise<void> {
    if (!this.crypto.isValidEncryptedEnvelope(envelope)) {
      return;
    }

    if (this.host.isBusyEditing() || this.activePersistPromise) {
      this.pendingExternalUpdate = { envelope, stamp };
      return;
    }

    await this.applyExternalUpdate(envelope, stamp);
  }

  /**
   * Applies any queued remote update once the user finishes editing a note, composer, or board.
   */
  public async flushPendingExternalUpdate(): Promise<void> {
    if (!this.pendingExternalUpdate || this.host.isBusyEditing() || this.activePersistPromise) {
      return;
    }
    const next = this.pendingExternalUpdate;
    this.pendingExternalUpdate = null;

    // If local edits were made while the remote update was queued, raise a conflict instead of overwriting
    const syncMeta = this.cache.loadSyncMeta();
    if (syncMeta.hasUnsyncedLocalChanges && this.host.passphrase) {
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

    await this.applyExternalUpdate(next.envelope, next.stamp);
  }

  private async applyExternalUpdate(
    envelope: EncryptedEnvelope,
    stamp: CloudFileStamp
  ): Promise<void> {
    const res = await this.importEnvelope(envelope, { source: 'cloud' });
    if (res === 'applied') {
      this.cloud.markRemoteStampAccepted(stamp);
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: stamp.fingerprint,
        hasUnsyncedLocalChanges: false,
      });
      this.setConflict(null);
      this.setSaveStatus({ state: 'saved', at: Date.now() });
      this.host.onCloudStatusChanged('connected');
    }
  }

  /**
   * Reconnects a saved cloud folder handle without discarding unsynced local work.
   */
  public async resumeCloudSync(): Promise<{
    reconnected: boolean;
    error?: string;
  }> {
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
      if (this.host.passphrase) {
        await this.persist({ forceCloudWrite: true });
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
      const outcome = await this.importEnvelope(readRes.envelope, { source: 'cloud' });
      if (outcome === 'applied') {
        this.cloud.markRemoteStampAccepted(readRes.stamp);
        this.cache.saveSyncMeta({
          lastSyncedFingerprint: cloudFp,
          hasUnsyncedLocalChanges: false,
        });
      }
    } else {
      this.cloud.markRemoteStampAccepted(readRes.stamp);
      this.cache.saveSyncMeta({
        lastSyncedFingerprint: cloudFp,
        hasUnsyncedLocalChanges: false,
      });
      this.setSaveStatus({ state: 'saved', at: Date.now() });
    }

    return { reconnected: true };
  }

  /**
   * Resolves an active sync conflict via non-destructive merge, keeping local, or loading remote.
   */
  public async resolveConflict(choice: 'merge' | 'keep_local' | 'keep_remote'): Promise<void> {
    const conflict = this.pendingConflict;
    if (!conflict) return;

    if (choice === 'keep_local') {
      if (!this.host.passphrase) {
        throw new Error('Unlock your vault before overwriting cloud with local changes.');
      }
      this.cloud.markRemoteStampAccepted(conflict.remoteStamp);
      await this.persist({ forceCloudWrite: true });
      this.setConflict(null);
      return;
    }

    if (choice === 'keep_remote') {
      const outcome = await this.importEnvelope(conflict.remoteEnvelope, { source: 'cloud' });
      if (outcome === 'applied') {
        this.cloud.markRemoteStampAccepted(conflict.remoteStamp);
        this.cache.saveSyncMeta({
          lastSyncedFingerprint: conflict.remoteStamp.fingerprint,
          hasUnsyncedLocalChanges: false,
        });
        this.setConflict(null);
        this.setSaveStatus({ state: 'saved', at: Date.now() });
      }
      return;
    }

    // choice === 'merge'
    if (!this.host.passphrase) {
      throw new Error('Unlock your vault before merging conflicting changes.');
    }
    const rawRemote = await this.crypto.decryptPayload(
      conflict.remoteEnvelope,
      this.host.passphrase
    );
    const remotePayload = normalizeVaultPayload(rawRemote);
    const localPayload = normalizeVaultPayload(this.host.getPayloadSnapshot());
    const merged = mergeVaultPayloads(localPayload, remotePayload);

    this.host.applyPayload(merged);
    this.host.renderAll();
    this.host.refreshBoardFromExternal();
    this.cloud.markRemoteStampAccepted(conflict.remoteStamp);
    await this.persist({ forceCloudWrite: true });
    this.setConflict(null);
  }

  /**
   * Locks the vault safely:
   * 1. Commits open drafts (edit modal, composer, board text) before clearing anything.
   * 2. Captures an encrypted snapshot & starts persistence if needed.
   * 3. Immediately wipes DOM & shows lock overlay so sensitive data is hidden right away.
   * 4. Flushes pending save with a bounded timeout so locking can never hang forever.
   */
  public async lock(options: {
    flushPending?: boolean;
    errorMsg?: string;
    timeoutMs?: number;
  } = {}): Promise<void> {
    const flushPending = Boolean(options.flushPending);
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_FLUSH_TIMEOUT_MS;
    let flushPromise: Promise<void> | null = null;
    let lockWarning = options.errorMsg;

    if (flushPending && this.host.passphrase) {
      const committedDraft = this.host.commitOpenDrafts();
      if (committedDraft) {
        flushPromise = this.persist().catch((err) => {
          lockWarning =
            lockWarning ??
            `Vault locked, but saving your latest draft failed: ${err instanceof Error ? err.message : String(err)}`;
        });
      } else if (this.activePersistPromise) {
        flushPromise = this.activePersistPromise.catch(() => {
          // status already surfaced
        });
      }
    }

    // Capture the flush promise BEFORE clearing state so writeOnce sees its captured snapshot
    // Wait a microtask if we just kicked off persist() so it captures payload & passphrase before wipe
    if (flushPromise) {
      const passphraseSnapshot = this.host.passphrase;
      // Show lock screen and clear visible DOM immediately while flush completes
      this.host.clearSensitiveStateAndDom();
      const targetMode = this.getActiveUnlockTargetEnvelope() ? 'unlock' : 'setup';
      this.host.showLockScreen(targetMode, lockWarning, {
        canCancelImport: this.pendingImportEnvelope !== null && this.host.lastEncryptedEnvelope !== null,
      });

      // Keep passphrase briefly only if persist needs to finish commit, bounded by timeout
      this.host.passphrase = passphraseSnapshot;
      let timedOut = false;
      await Promise.race([
        flushPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);

      this.host.passphrase = null;
      this.persistAgainRequested = false;
      if (timedOut && !lockWarning) {
        this.host.showLockScreen(
          this.getActiveUnlockTargetEnvelope() ? 'unlock' : 'setup',
          'Vault locked, but background save timed out. Verify your latest edit after unlocking.'
        );
      } else if (lockWarning && lockWarning !== options.errorMsg) {
        this.host.showLockScreen(
          this.getActiveUnlockTargetEnvelope() ? 'unlock' : 'setup',
          lockWarning
        );
      }
      return;
    }

    this.persistAgainRequested = false;
    this.host.passphrase = null;
    this.pendingLegacyUpgradePayload = null;
    this.host.clearSensitiveStateAndDom();
    const targetMode = this.getActiveUnlockTargetEnvelope() ? 'unlock' : 'setup';
    this.host.showLockScreen(targetMode, lockWarning, {
      canCancelImport: this.pendingImportEnvelope !== null && this.host.lastEncryptedEnvelope !== null,
    });
  }
}
