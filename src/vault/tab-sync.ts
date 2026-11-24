/**
 * Crypsy — Cross-Tab Vault Coordination (Web Locks + BroadcastChannel + storage fallback)
 *
 * Serializes local cache and cloud folder writes across multiple open browser tabs
 * and notifies peer tabs whenever a vault write commits so tabs never silently
 * overwrite each other.
 */

export interface TabVaultUpdateNotice {
  fingerprint: string;
  revision: number;
  sourceTabId: string;
  at: number;
}

export interface VaultTabCoordinator {
  readonly tabId: string;
  withExclusiveLock: <T>(fn: () => Promise<T>) => Promise<T>;
  notifyVaultUpdated: (fingerprint: string, revision: number) => void;
  onRemoteTabUpdated: (cb: (notice: TabVaultUpdateNotice) => void) => () => void;
}

const LOCK_NAME = 'crypsy_vault_io_lock_v1';
const CHANNEL_NAME = 'crypsy_vault_tab_sync_v1';
const STORAGE_PING_KEY = 'crypsy_vault_tab_ping_v1';

function generateTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createNoopTabCoordinator(): VaultTabCoordinator {
  let chain: Promise<unknown> = Promise.resolve();
  const tabId = generateTabId();
  return {
    tabId,
    withExclusiveLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn, fn);
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    notifyVaultUpdated: () => {},
    onRemoteTabUpdated: () => () => {},
  };
}

export function createBrowserTabCoordinator(): VaultTabCoordinator {
  const tabId = generateTabId();
  let inProcessChain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(notice: TabVaultUpdateNotice) => void>();

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as Partial<TabVaultUpdateNotice> | null;
        if (
          !data ||
          typeof data.fingerprint !== 'string' ||
          typeof data.sourceTabId !== 'string' ||
          data.sourceTabId === tabId
        ) {
          return;
        }
        const notice: TabVaultUpdateNotice = {
          fingerprint: data.fingerprint,
          revision: typeof data.revision === 'number' ? data.revision : 0,
          sourceTabId: data.sourceTabId,
          at: typeof data.at === 'number' ? data.at : Date.now(),
        };
        for (const cb of listeners) cb(notice);
      };
    } catch {
      channel = null;
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== STORAGE_PING_KEY || !e.newValue) return;
      try {
        const data = JSON.parse(e.newValue) as Partial<TabVaultUpdateNotice>;
        if (
          !data ||
          typeof data.fingerprint !== 'string' ||
          typeof data.sourceTabId !== 'string' ||
          data.sourceTabId === tabId
        ) {
          return;
        }
        const notice: TabVaultUpdateNotice = {
          fingerprint: data.fingerprint,
          revision: typeof data.revision === 'number' ? data.revision : 0,
          sourceTabId: data.sourceTabId,
          at: typeof data.at === 'number' ? data.at : Date.now(),
        };
        for (const cb of listeners) cb(notice);
      } catch {
        // ignore malformed storage event
      }
    });
  }

  const withExclusiveLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const runLocally = async (): Promise<T> => {
      const next = inProcessChain.then(fn, fn);
      inProcessChain = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    };

    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => runLocally());
    }
    return runLocally();
  };

  const notifyVaultUpdated = (fingerprint: string, revision: number): void => {
    const notice: TabVaultUpdateNotice = {
      fingerprint,
      revision,
      sourceTabId: tabId,
      at: Date.now(),
    };
    if (channel) {
      try {
        channel.postMessage(notice);
      } catch {
        // ignore closed channel
      }
    }
    try {
      localStorage.setItem(STORAGE_PING_KEY, JSON.stringify(notice));
    } catch {
      // ignore storage failure
    }
  };

  const onRemoteTabUpdated = (cb: (notice: TabVaultUpdateNotice) => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };

  return {
    tabId,
    withExclusiveLock,
    notifyVaultUpdated,
    onRemoteTabUpdated,
  };
}
