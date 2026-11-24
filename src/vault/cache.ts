/**
 * Lightweight IndexedDB key-value helpers (auto-closing connections, abort-safe),
 * single-authority local encrypted vault cache storage (IndexedDB primary,
 * localStorage fallback only when IndexedDB is unavailable), and a rolling
 * local backup ring of the last 5 distinct encrypted envelopes.
 */

import type { EncryptedEnvelope } from '../types';
import { envelopeFingerprint, isValidEncryptedEnvelope } from './crypto';

const STORAGE_KEY_VAULT = 'crypsy_encrypted_vault_v1';
const STORAGE_KEY_VAULT_HISTORY = 'crypsy_encrypted_vault_history_v1';
const STORAGE_KEY_SYNC_META = 'crypsy_vault_sync_meta_v1';
const VAULT_IDB_NAME = 'crypsy_vault_cache_db_v1';
const VAULT_IDB_STORE = 'vault';
const VAULT_IDB_KEY = 'encrypted_envelope';
const VAULT_IDB_HISTORY_KEY = 'encrypted_envelope_history';
const MAX_BACKUP_ENVELOPES = 5;

export interface LocalSyncMeta {
  lastSyncedFingerprint: string | null;
  hasUnsyncedLocalChanges: boolean;
  highestAcceptedRevision?: number | undefined;
  highestAcceptedVersion?: number | undefined;
}

export interface VaultCacheStorage {
  saveEnvelope: (envelope: EncryptedEnvelope) => Promise<void>;
  loadEnvelope: () => Promise<EncryptedEnvelope | null>;
  loadBackupEnvelopes?: () => Promise<EncryptedEnvelope[]>;
  loadSyncMeta: () => LocalSyncMeta;
  saveSyncMeta: (meta: LocalSyncMeta) => void;
}

function openKeyValueDB(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

export async function idbPut<T>(
  dbName: string,
  storeName: string,
  key: string,
  value: T
): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openKeyValueDB(dbName, storeName);
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  } finally {
    db?.close();
  }
}

export async function idbGet<T>(
  dbName: string,
  storeName: string,
  key: string
): Promise<T | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openKeyValueDB(dbName, storeName);
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db!.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
    });
  } finally {
    db?.close();
  }
}

export async function idbDelete(
  dbName: string,
  storeName: string,
  key: string
): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openKeyValueDB(dbName, storeName);
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB delete aborted'));
    });
  } finally {
    db?.close();
  }
}

function envelopeTimestampMs(env: EncryptedEnvelope): number {
  const rev = typeof env.revision === 'number' && Number.isFinite(env.revision) ? env.revision : 0;
  const ts = env.updatedAt ? Date.parse(env.updatedAt) : 0;
  return Number.isFinite(ts) ? ts + rev * 0.001 : rev;
}

function pickNewerEnvelope(
  a: EncryptedEnvelope | null,
  b: EncryptedEnvelope | null
): EncryptedEnvelope | null {
  if (!a) return b;
  if (!b) return a;
  if ((a.revision ?? 0) !== (b.revision ?? 0)) {
    return (a.revision ?? 0) >= (b.revision ?? 0) ? a : b;
  }
  return envelopeTimestampMs(a) >= envelopeTimestampMs(b) ? a : b;
}

export function appendToEnvelopeHistory(
  existingHistory: EncryptedEnvelope[],
  previousEnvelope: EncryptedEnvelope | null,
  incomingEnvelope: EncryptedEnvelope
): EncryptedEnvelope[] {
  if (!previousEnvelope) return existingHistory.slice(0, MAX_BACKUP_ENVELOPES);
  const prevFp = envelopeFingerprint(previousEnvelope);
  const nextFp = envelopeFingerprint(incomingEnvelope);
  if (prevFp === nextFp) return existingHistory.slice(0, MAX_BACKUP_ENVELOPES);

  const out: EncryptedEnvelope[] = [previousEnvelope];
  const seen = new Set<string>([prevFp, nextFp]);
  for (const env of existingHistory) {
    if (out.length >= MAX_BACKUP_ENVELOPES) break;
    if (!isValidEncryptedEnvelope(env)) continue;
    const fp = envelopeFingerprint(env);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(env);
  }
  return out;
}

export async function loadBackupEnvelopesFromCache(): Promise<EncryptedEnvelope[]> {
  try {
    const raw = await idbGet<unknown>(VAULT_IDB_NAME, VAULT_IDB_STORE, VAULT_IDB_HISTORY_KEY);
    if (Array.isArray(raw)) {
      return raw.filter((item): item is EncryptedEnvelope => isValidEncryptedEnvelope(item));
    }
  } catch {
    // Fallback below
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_VAULT_HISTORY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is EncryptedEnvelope => isValidEncryptedEnvelope(item));
      }
    }
  } catch {
    // ignore
  }
  return [];
}

export async function saveVaultEnvelopeToCache(envelope: EncryptedEnvelope): Promise<void> {
  const previous = await loadVaultEnvelopeFromCache().catch(() => null);
  const existingHistory = previous ? await loadBackupEnvelopesFromCache().catch(() => []) : [];
  const nextHistory = appendToEnvelopeHistory(existingHistory, previous, envelope);

  let idbErr: unknown = null;
  try {
    await idbPut(VAULT_IDB_NAME, VAULT_IDB_STORE, VAULT_IDB_KEY, envelope);
    if (nextHistory.length > 0) {
      await idbPut(VAULT_IDB_NAME, VAULT_IDB_STORE, VAULT_IDB_HISTORY_KEY, nextHistory).catch(
        () => {}
      );
    }
    // Keep a single authoritative cache: clear any legacy localStorage copy once IDB write succeeds.
    try {
      localStorage.removeItem(STORAGE_KEY_VAULT);
      localStorage.removeItem(STORAGE_KEY_VAULT_HISTORY);
    } catch {
      // ignore storage access issues
    }
    return;
  } catch (err) {
    idbErr = err;
  }

  // Fallback to localStorage only if IndexedDB is unavailable or fails
  try {
    localStorage.setItem(STORAGE_KEY_VAULT, JSON.stringify(envelope));
    if (nextHistory.length > 0) {
      try {
        localStorage.setItem(STORAGE_KEY_VAULT_HISTORY, JSON.stringify(nextHistory));
      } catch {
        // Backup ring must never block primary save when localStorage quota is tight
      }
    }
  } catch (lsErr) {
    const idbMsg = idbErr instanceof Error ? idbErr.message : String(idbErr);
    const lsMsg = lsErr instanceof Error ? lsErr.message : String(lsErr);
    throw new Error(
      `Could not persist encrypted vault locally (IDB: ${idbMsg}; localStorage: ${lsMsg})`
    );
  }
}

export async function loadVaultEnvelopeFromCache(): Promise<EncryptedEnvelope | null> {
  let fromIdb: EncryptedEnvelope | null = null;
  try {
    const raw = await idbGet<unknown>(VAULT_IDB_NAME, VAULT_IDB_STORE, VAULT_IDB_KEY);
    if (isValidEncryptedEnvelope(raw)) {
      fromIdb = raw;
    }
  } catch {
    // Fallback to localStorage below
  }

  let fromLs: EncryptedEnvelope | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_VAULT);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValidEncryptedEnvelope(parsed)) {
        fromLs = parsed;
      }
    }
  } catch {
    // Ignore corrupt localStorage cache
  }

  // If both exist from an older dual-cache version, always choose the newer one
  return pickNewerEnvelope(fromIdb, fromLs);
}

export function loadLocalSyncMeta(): LocalSyncMeta {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SYNC_META);
    if (!raw) {
      return {
        lastSyncedFingerprint: null,
        hasUnsyncedLocalChanges: false,
        highestAcceptedRevision: 0,
        highestAcceptedVersion: 1,
      };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rev =
      typeof parsed.highestAcceptedRevision === 'number' &&
      Number.isFinite(parsed.highestAcceptedRevision) &&
      parsed.highestAcceptedRevision >= 0
        ? Math.floor(parsed.highestAcceptedRevision)
        : 0;
    const ver =
      typeof parsed.highestAcceptedVersion === 'number' &&
      Number.isFinite(parsed.highestAcceptedVersion) &&
      parsed.highestAcceptedVersion >= 1
        ? Math.floor(parsed.highestAcceptedVersion)
        : 1;
    return {
      lastSyncedFingerprint:
        typeof parsed.lastSyncedFingerprint === 'string' ? parsed.lastSyncedFingerprint : null,
      hasUnsyncedLocalChanges: Boolean(parsed.hasUnsyncedLocalChanges),
      highestAcceptedRevision: rev,
      highestAcceptedVersion: ver,
    };
  } catch {
    return {
      lastSyncedFingerprint: null,
      hasUnsyncedLocalChanges: false,
      highestAcceptedRevision: 0,
      highestAcceptedVersion: 1,
    };
  }
}

export function saveLocalSyncMeta(meta: LocalSyncMeta): void {
  try {
    const existing = loadLocalSyncMeta();
    const highestAcceptedRevision = Math.max(
      existing.highestAcceptedRevision ?? 0,
      meta.highestAcceptedRevision ?? 0
    );
    const highestAcceptedVersion = Math.max(
      existing.highestAcceptedVersion ?? 1,
      meta.highestAcceptedVersion ?? 1
    );
    localStorage.setItem(
      STORAGE_KEY_SYNC_META,
      JSON.stringify({
        lastSyncedFingerprint: meta.lastSyncedFingerprint,
        hasUnsyncedLocalChanges: meta.hasUnsyncedLocalChanges,
        highestAcceptedRevision,
        highestAcceptedVersion,
      })
    );
  } catch {
    // ignore
  }
}

export function createBrowserVaultCache(): VaultCacheStorage {
  return {
    saveEnvelope: saveVaultEnvelopeToCache,
    loadEnvelope: loadVaultEnvelopeFromCache,
    loadBackupEnvelopes: loadBackupEnvelopesFromCache,
    loadSyncMeta: loadLocalSyncMeta,
    saveSyncMeta: saveLocalSyncMeta,
  };
}
