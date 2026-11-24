import { expect, type Page } from '@playwright/test';

/** Valid 1x1 blue PNG image (68 bytes) for deterministic offline M1 HTTPS fetch tests. */
export const SAMPLE_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzbpFsPDAAAAAElFTkSuQmCC',
  'base64'
);

export const TEST_PASS = 'correct-horse-battery-1';
export const TEST_PASS_2 = 'purple-monkey-dishwasher-2';

export async function createVault(page: Page, passphrase = TEST_PASS): Promise<void> {
  await expect(page.locator('#lockScreenOverlay')).toBeVisible();
  await expect(page.locator('#unlockConfirmWrapper')).toBeVisible();
  await page.fill('#unlockPassphraseInput', passphrase);
  await page.fill('#unlockConfirmPassphraseInput', passphrase);
  await page.click('#unlockSubmitBtn');
  await expect(page.locator('#lockScreenOverlay')).toBeHidden({ timeout: 15_000 });
}

export async function unlockVault(page: Page, passphrase = TEST_PASS): Promise<void> {
  await expect(page.locator('#lockScreenOverlay')).toBeVisible();
  await page.fill('#unlockPassphraseInput', passphrase);
  await page.click('#unlockSubmitBtn');
  await expect(page.locator('#lockScreenOverlay')).toBeHidden({ timeout: 15_000 });
}

export async function addNoteViaComposer(
  page: Page,
  title: string,
  description: string
): Promise<void> {
  await page.click('#composerDescription');
  await expect(page.locator('#composerHeader')).toBeVisible();
  await page.fill('#composerTitle', title);
  await page.fill('#composerDescription', description);
  await page.click('#composerSaveBtn');
  await expect(page.locator('.note-card', { hasText: title }).first()).toBeVisible();
  await waitForSavedStatus(page);
}

export async function waitForSavedStatus(page: Page): Promise<void> {
  await expect(page.locator('#lastUpdatedText')).toContainText(/Saved|Synced/i, {
    timeout: 10_000,
  });
}

/**
 * Injects an in-memory File System Access API (`window.showDirectoryPicker`) mock
 * before page boot so real `cloud-sync.ts` folder linking, optimistic write conflict
 * checks, and 3.5-second polling run end-to-end without native OS picker dialogs.
 */
export async function installMockCloudFolder(
  page: Page,
  initialFiles: Record<string, string> = {}
): Promise<void> {
  await page.addInitScript((seedFiles: Record<string, string>) => {
    interface MemFileEntry {
      content: string;
      lastModified: number;
    }

    const files = new Map<string, MemFileEntry>();
    let clock = Date.now();
    for (const [name, content] of Object.entries(seedFiles)) {
      files.set(name, { content, lastModified: clock++ });
    }

    const makeFileHandle = (name: string) => ({
      kind: 'file',
      name,
      async getFile() {
        const entry = files.get(name);
        if (!entry) {
          const err = new DOMException(`File ${name} not found`, 'NotFoundError');
          throw err;
        }
        return new File([entry.content], name, {
          type: 'application/json',
          lastModified: entry.lastModified,
        });
      },
      async createWritable() {
        let buffer = '';
        return {
          async write(chunk: unknown) {
            buffer += typeof chunk === 'string' ? chunk : String(chunk);
          },
          async close() {
            clock += 1000;
            files.set(name, { content: buffer, lastModified: clock });
          },
        };
      },
    });

    const dirHandle = {
      kind: 'directory',
      name: 'Crypsy',
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      },
      async getDirectoryHandle(_subName: string) {
        return dirHandle;
      },
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        if (!files.has(name)) {
          if (opts?.create) {
            clock += 1000;
            files.set(name, { content: '', lastModified: clock });
          } else {
            throw new DOMException(`File ${name} not found`, 'NotFoundError');
          }
        }
        return makeFileHandle(name);
      },
    };

    (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => dirHandle;
    (window as unknown as Record<string, unknown>).__mockCloudFs = {
      getText: (name: string) => files.get(name)?.content ?? null,
      setText: (name: string, content: string) => {
        clock += 5000;
        files.set(name, { content, lastModified: clock });
      },
      has: (name: string) => files.has(name),
      list: () => Array.from(files.keys()),
    };
  }, initialFiles);
}
