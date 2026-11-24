import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

import { encryptPayload } from '../src/vault/crypto';
import type { VaultPayload } from '../src/types';
import {
  SAMPLE_PNG_BUFFER,
  TEST_PASS,
  TEST_PASS_2,
  addNoteViaComposer,
  createVault,
  installMockCloudFolder,
  unlockVault,
  waitForSavedStatus,
} from './helpers';

test.describe('Crypsy Note Browser E2E (Security & Reliability)', () => {
  test('1. setup passphrase validation (M6), persistence across reload & lock DOM hygiene', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    // Lock screen is visible on initial paint and does not invite browser password-manager autofill
    await expect(page.locator('#lockScreenOverlay')).toBeVisible();
    await expect(page.locator('#unlockPassphraseInput')).toHaveAttribute('autocomplete', 'new-password');

    // Weak sequential 12-char passphrase is rejected (M6)
    await page.fill('#unlockPassphraseInput', '123456789012');
    await page.fill('#unlockConfirmPassphraseInput', '123456789012');
    await page.click('#unlockSubmitBtn');
    await expect(page.locator('#unlockErrorMsg')).toBeVisible();
    await expect(page.locator('#unlockErrorMsg')).toContainText(/stronger passphrase/i);

    // Create vault with strong passphrase
    await createVault(page, TEST_PASS);
    await expect(page.locator('.note-card')).toHaveCount(4);

    // Add a custom note and verify persistence across reload
    await addNoteViaComposer(page, 'E2E Secret Note', 'Encrypted body content');
    await page.reload();

    // Unlock mode must use autocomplete="off"
    await expect(page.locator('#lockScreenOverlay')).toBeVisible();
    await expect(page.locator('#unlockPassphraseInput')).toHaveAttribute('autocomplete', 'off');
    await unlockVault(page, TEST_PASS);
    await expect(page.locator('.note-card', { hasText: 'E2E Secret Note' })).toBeVisible();

    // Open composer popover with sensitive input, then lock via topbar button -> DOM must wipe cleanly
    await page.click('#composerDescription');
    await page.click('#composerImageBtn');
    await page.fill('#composerImageUrlInput', 'https://private.example/secret.png');
    await page.click('#topbarLockBtn');

    await expect(page.locator('#lockScreenOverlay')).toBeVisible();
    await expect(page.locator('#pinnedGrid')).toBeEmpty();
    await expect(page.locator('#othersGrid')).toBeEmpty();
    await expect(page.locator('#composerImageUrlInput')).toHaveValue('');
    await expect(page.locator('#composerImagePopover')).toHaveClass(/hidden/);
    expect(pageErrors).toEqual([]);
  });

  test('2. C1 real DOM trigger: locking with an open empty board text box never wipes the vault', async ({
    page,
  }) => {
    await page.goto('/');
    await createVault(page, TEST_PASS);
    await addNoteViaComposer(page, 'Must Survive C1', 'Vault must not become empty on board lock');

    // Create and open a new spatial board
    await page.fill('#newBoardInput', 'C1 Repro Board');
    await page.click('#newBoardBtn');
    await expect(page.locator('#boardEditorBackdrop')).toBeVisible();
    await waitForSavedStatus(page);

    // Click empty board canvas -> creates an empty text box in edit mode (exact deterministic C1 trigger)
    const viewport = page.locator('#boardCanvasViewport');
    const box = await viewport.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    await expect(page.locator('[data-board-textarea]')).toBeVisible();

    // Trigger lock directly via Ctrl+Shift+L while the empty text box is open in edit mode!
    // Blur textarea first or dispatch shortcut (Ctrl+Shift+L works even when editing? Check app.ts:
    // BoardEditor handles non-shortcut keys, let's verify pressing Escape isn't needed!)
    await page.keyboard.press('Control+Shift+L');
    await expect(page.locator('#lockScreenOverlay')).toBeVisible({ timeout: 10_000 });

    // Unlock and verify BOTH the notes AND the board survived (0% vault wipe!)
    await unlockVault(page, TEST_PASS);
    await expect(page.locator('#countAll')).toHaveText('5');
    await expect(page.locator('#countBoards')).toHaveText('1');
    await page.click('[data-filter-type="all"]');
    await expect(page.locator('.note-card', { hasText: 'Must Survive C1' })).toBeVisible();
  });

  test('3. M1 real Chrome CSP: HTTPS URL images fetch and embed as encrypted WebP with zero CSP errors', async ({
    page,
  }) => {
    const cspErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /content security policy/i.test(msg.text())) {
        cspErrors.push(msg.text());
      }
    });

    await page.route('https://img.crypsy.test/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Access-Control-Allow-Origin': '*',
        },
        body: SAMPLE_PNG_BUFFER,
      });
    });

    await page.goto('/');
    await createVault(page, TEST_PASS);

    await page.click('#composerDescription');
    await page.fill('#composerTitle', 'Embedded URL Image Note');
    await page.click('#composerImageBtn');
    await page.fill('#composerImageUrlInput', 'https://img.crypsy.test/pixel.png');
    await page.click('#composerAddImageUrlBtn');

    await expect(page.locator('#composerImageStatus')).toContainText(
      /Downloaded & encrypted as WebP/i
    );
    await page.click('#composerSaveBtn');

    const card = page.locator('.note-card', { hasText: 'Embedded URL Image Note' });
    await expect(card).toBeVisible();
    await expect(card.locator('.note-image-badge')).toHaveText('Encrypted WebP');
    const imgSrc = await card.locator('.note-image-item img').getAttribute('src');
    expect(imgSrc).toMatch(/^data:image\/(webp|jpeg);base64,/);
    expect(cspErrors).toEqual([]);
  });

  test('4. M2 real DOM Strict Media Privacy: blocks crafted backslash URLs and gates board lightbox', async ({
    page,
  }) => {
    const trackerRequests: string[] = [];
    await page.route('https://tracker.crypsy.test/**', async (route) => {
      trackerRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
        body: SAMPLE_PNG_BUFFER,
      });
    });

    // Craft a real encrypted vault containing a backslash-trick URL claiming sourceType: 'embedded'
    // plus a board image pointing at an external tracker URL
    const craftedPayload: VaultPayload = {
      notes: [
        {
          id: 'n-m2',
          title: 'Crafted Media Note',
          description: 'Body',
          tags: [],
          pinned: false,
          color: 'default',
          images: [
            {
              id: 'img-crafted',
              src: 'https:\\\\tracker.crypsy.test\\note-pixel.png',
              sourceType: 'embedded',
              createdAt: 1000,
            },
          ],
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      tags: [],
      boards: [
        {
          id: 'b-m2',
          title: 'Crafted Media Board',
          tags: [],
          pinned: false,
          color: 'default',
          viewport: { panX: 0, panY: 0, zoom: 1 },
          items: [
            {
              id: 'bi-img',
              type: 'image',
              x: 80,
              y: 80,
              width: 240,
              height: 160,
              rotation: 0,
              zIndex: 1,
              image: {
                id: 'img-board',
                src: 'https://tracker.crypsy.test/board-pixel.png',
                sourceType: 'external',
                createdAt: 1000,
              },
            },
          ],
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    };
    const craftedEnvelope = await encryptPayload(craftedPayload, TEST_PASS, { revision: 1 });

    await page.goto('/');
    await expect(page.locator('#lockScreenOverlay')).toBeVisible();

    // Import crafted vault from lock screen and unlock
    await page.setInputFiles('#lockImportVaultInput', {
      name: 'crafted.crypsy.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(craftedEnvelope), 'utf8'),
    });
    await unlockVault(page, TEST_PASS);

    // Note card MUST show blocked placeholder (NOT live <img>) and External URL badge
    const noteCard = page.locator('.note-card', { hasText: 'Crafted Media Note' });
    await expect(noteCard.locator('.blocked-external-image')).toBeVisible();
    await expect(noteCard.locator('.note-image-badge')).toHaveText('External URL');
    expect(trackerRequests).toEqual([]);

    // Open board -> board image MUST be blocked and double-clicking MUST NOT open lightbox!
    await page.click('.sidebar-board-item');
    await expect(page.locator('#boardEditorBackdrop')).toBeVisible();
    const boardImgItem = page.locator('[data-board-item-id="bi-img"]');
    await expect(boardImgItem.locator('.blocked-external-board-image')).toBeVisible();
    await boardImgItem.dblclick();
    await expect(page.locator('#imageLightboxBackdrop')).toHaveClass(/hidden/);
    expect(trackerRequests).toEqual([]);

    // Clicking "Load once" explicitly allows the image for the session (and lightbox now works)
    await boardImgItem.locator('.blocked-external-load-btn').click();
    await expect(boardImgItem.locator('img')).toBeVisible();
    await expect
      .poll(() => trackerRequests)
      .toContain('https://tracker.crypsy.test/board-pixel.png');
    await boardImgItem.dblclick();
    await expect(page.locator('#imageLightboxBackdrop')).toBeVisible();
  });

  test('5. M6 Vault Modal requires verifying current passphrase before re-keying', async ({
    page,
  }) => {
    await page.goto('/');
    await createVault(page, TEST_PASS);
    await addNoteViaComposer(page, 'Before Rekey', 'Still readable after rekey');

    await page.click('#encryptionBadge');
    await expect(page.locator('#vaultModalBackdrop')).toBeVisible();

    // Wrong current passphrase MUST be rejected
    await page.fill('#vaultCurrentPassphraseInput', 'wrong-current-passphrase');
    await page.fill('#vaultPassphraseInput', TEST_PASS_2);
    await page.fill('#vaultConfirmPassphraseInput', TEST_PASS_2);
    await page.click('#updatePassphraseBtn');
    await expect(page.locator('#vaultPassphraseFeedback')).toContainText(
      /Current passphrase is incorrect/i
    );

    // Correct current passphrase succeeds
    await page.fill('#vaultCurrentPassphraseInput', TEST_PASS);
    await page.click('#updatePassphraseBtn');
    await expect(page.locator('#vaultPassphraseFeedback')).toContainText(/Vault re-keyed/i, {
      timeout: 15_000,
    });

    // Lock -> old passphrase fails, new passphrase unlocks with notes intact
    await page.click('#lockVaultNowBtn');
    await expect(page.locator('#lockScreenOverlay')).toBeVisible();

    await page.fill('#unlockPassphraseInput', TEST_PASS);
    await page.click('#unlockSubmitBtn');
    await expect(page.locator('#unlockErrorMsg')).toBeVisible();

    await unlockVault(page, TEST_PASS_2);
    await expect(page.locator('.note-card', { hasText: 'Before Rekey' })).toBeVisible();
  });

  test('6. H5 & H3 Cloud folder linking confirms destructive replacement and keeps sync conflicts sticky across polls', async ({
    page,
  }) => {
    // Part A (H5): Pre-seed cloud folder with an existing vault; cancelling confirmation keeps local vault unlinked
    const preExistingCloud = await encryptPayload(
      {
        notes: [
          {
            id: 'n-cloud-existing',
            title: 'Pre-Existing Cloud Note',
            description: 'From cloud',
            tags: [],
            pinned: false,
            color: 'default',
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        tags: [],
        boards: [],
      },
      TEST_PASS,
      { revision: 3 }
    );

    await installMockCloudFolder(page, {
      'vault.crypsy.json': JSON.stringify(preExistingCloud),
    });
    await page.goto('/');
    await createVault(page, TEST_PASS);
    await addNoteViaComposer(page, 'Local Precious Note', 'Do not replace without consent');

    let dialogCount = 0;
    page.once('dialog', async (dialog) => {
      dialogCount++;
      expect(dialog.message()).toMatch(/already contains an encrypted vault/i);
      await dialog.dismiss();
    });

    await page.click('#cloudSetupBtn');
    await page.click('#wizardToStep2Btn');
    await page.click('#pickAndProvisionBtn');

    // Declined confirmation -> local note preserved and cloud status stays unlinked!
    await expect.poll(() => dialogCount).toBe(1);
    await expect(page.locator('.note-card', { hasText: 'Local Precious Note' })).toBeVisible();
    await expect(page.locator('#cloudSetupBtnLabel')).toHaveText('Setup Cloud Folder');

    // Part B (H3): Link a clean folder, simulate external Device B update, create local edit ->
    // conflict banner appears, survives past a 3.5s poll cycle, and Merge Both keeps BOTH notes!
    await page.evaluate(() => {
      // Replace mock cloud file cleanly? Simpler: remove existing file by accepting link after wiping via helper
      (window as unknown as { __mockCloudFs: { setText: (k: string, v: string) => void } }).__mockCloudFs;
    });

    // Accept linking the pre-existing cloud vault now (dialog.accept) to establish connected sync
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await page.click('#pickAndProvisionBtn');
    await expect(page.locator('#wizardStep3')).toBeVisible({ timeout: 10_000 });
    await page.click('#finishOnboardingBtn');
    await expect(page.locator('.note-card', { hasText: 'Pre-Existing Cloud Note' })).toBeVisible();

    // Simulate Device B writing rev 4 to vault.crypsy.json while Device A is about to edit
    const deviceBEnv = await encryptPayload(
      {
        notes: [
          {
            id: 'n-cloud-existing',
            title: 'Pre-Existing Cloud Note',
            description: 'From cloud',
            tags: [],
            pinned: false,
            color: 'default',
            createdAt: 1000,
            updatedAt: 1000,
          },
          {
            id: 'n-device-b',
            title: 'From Device B',
            description: 'Written remotely',
            tags: [],
            pinned: false,
            color: 'default',
            createdAt: 2000,
            updatedAt: 2000,
          },
        ],
        tags: [],
        boards: [],
      },
      TEST_PASS,
      { revision: 4 }
    );

    // Open composer (busy editing) before Device B writes, then write Device B file, then save Device A note
    await page.click('#composerDescription');
    await page.fill('#composerTitle', 'From Device A');
    await page.fill('#composerDescription', 'Local conflicting note');

    await page.evaluate((envJson: string) => {
      const fs = (
        window as unknown as { __mockCloudFs: { setText: (name: string, val: string) => void } }
      ).__mockCloudFs;
      fs.setText('vault.crypsy.json', envJson);
    }, JSON.stringify(deviceBEnv));

    await page.click('#composerSaveBtn');

    // Sync conflict banner MUST appear
    await expect(page.locator('#syncConflictBanner')).toBeVisible({ timeout: 10_000 });

    // Wait > 4 seconds (longer than the 3.5s poll interval) -> H3: conflict MUST stay sticky!
    await page.waitForTimeout(4200);
    await expect(page.locator('#syncConflictBanner')).toBeVisible();
    await expect(page.locator('.note-card', { hasText: 'From Device A' })).toBeVisible();

    // Resolve with Merge Both -> BOTH Device A and Device B notes survive!
    await page.click('#conflictMergeBtn');
    await expect(page.locator('#syncConflictBanner')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('.note-card', { hasText: 'From Device A' })).toBeVisible();
    await expect(page.locator('.note-card', { hasText: 'From Device B' })).toBeVisible();
  });

  test('7. H6 real two-tab concurrency: concurrent edits in two tabs raise conflict instead of silent overwrite', async ({
    context,
  }) => {
    const tabA = await context.newPage();
    await tabA.goto('/');
    await createVault(tabA, TEST_PASS);
    await waitForSavedStatus(tabA);

    const tabB = await context.newPage();
    await tabB.goto('/');
    await unlockVault(tabB, TEST_PASS);

    // Start editing a draft in Tab B (so Tab B is busy when Tab A saves)
    await tabB.click('#composerDescription');
    await tabB.fill('#composerTitle', 'Tab B Note');
    await tabB.fill('#composerDescription', 'Concurrent edit in Tab B');

    // Save a new note in Tab A
    await addNoteViaComposer(tabA, 'Tab A Note', 'Saved first in Tab A');

    // Now save Tab B's note -> Tab B MUST detect cross-tab cache divergence and show conflict banner!
    await tabB.click('#composerSaveBtn');
    await expect(tabB.locator('#syncConflictBanner')).toBeVisible({ timeout: 10_000 });

    // Merge Both in Tab B preserves BOTH Tab A Note and Tab B Note!
    await tabB.click('#conflictMergeBtn');
    await expect(tabB.locator('#syncConflictBanner')).toBeHidden({ timeout: 10_000 });
    await expect(tabB.locator('.note-card', { hasText: 'Tab A Note' })).toBeVisible();
    await expect(tabB.locator('.note-card', { hasText: 'Tab B Note' })).toBeVisible();
  });

  test('8. Portable HTML (file://) boots with zero CSP errors and supports full create/lock/unlock cycle', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    const portablePath = path.resolve(process.cwd(), 'Crypsy-Portable.html');
    await page.goto(pathToFileURL(portablePath).href);

    await createVault(page, TEST_PASS);
    await addNoteViaComposer(page, 'Portable Note', 'Running directly from file://');

    await page.click('#topbarLockBtn');
    await expect(page.locator('#lockScreenOverlay')).toBeVisible();

    await unlockVault(page, TEST_PASS);
    await expect(page.locator('.note-card', { hasText: 'Portable Note' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
