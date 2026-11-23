/**
 * Lightweight IndexedDB key-value helpers (auto-closing connections)
 * and local encrypted vault cache storage (IndexedDB + localStorage fallback).
 */

import type { EncryptedEnvelope } from '../types';

const STORAGE_KEY_VAULT = 'crypsy_encrypted_vault_v1';
const VAULT_IDB_NAME = 'crypsy_vault_cache_db_v1';
const VAULT_IDB_STORE = 'vault';
const VAULT_IDB_KEY = 'encrypted_envelope';

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
    req.onerror = () => reject(req.error);
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
      tx.onerror = () => reject(tx.error);
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
      req.onerror = () => reject(req.error);
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
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db?.close();
  }
}

export async function saveVaultEnvelopeToCache(envelope: EncryptedEnvelope): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY_VAULT, JSON.stringify(envelope));
  } catch {
    // QuotaExceededError when vault has large images; IndexedDB stores full envelope below
  }
  try {
    await idbPut(VAULT_IDB_NAME, VAULT_IDB_STORE, VAULT_IDB_KEY, envelope);
  } catch {
    // Ignore IDB failure if localStorage succeeded
  }
}

export async function loadVaultEnvelopeFromCache(): Promise<EncryptedEnvelope | null> {
  try {
    const fromIdb = await idbGet<EncryptedEnvelope>(VAULT_IDB_NAME, VAULT_IDB_STORE, VAULT_IDB_KEY);
    if (fromIdb) return fromIdb;
  } catch {
    // Fallback to localStorage
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_VAULT);
    return raw ? (JSON.parse(raw) as EncryptedEnvelope) : null;
  } catch {
    return null;
  }
}
