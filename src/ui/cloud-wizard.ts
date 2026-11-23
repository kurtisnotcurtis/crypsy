/**
 * Crypsy — Cloud Folder Onboarding Wizard Controller
 * Manages the 3-step BYOC cloud folder linking, portable HTML provisioning,
 * and mobile share/import wizard modal.
 */

import { CrypsyCloudSync } from '../vault/cloud-sync';
import type { CloudProviderId, EncryptedEnvelope, RestoreConnectionResult } from '../types';
import { byId, maybeById } from '../utils';

export interface CloudWizardHost {
  getSelectedProviderId: () => CloudProviderId;
  setSelectedProviderId: (id: CloudProviderId) => void;
  tryLoadEnvelope: (envelope: EncryptedEnvelope) => Promise<boolean>;
  persistEncryptedVault: () => Promise<void>;
  updateCloudStatusUI: (restoredState?: Pick<RestoreConnectionResult, 'status'>) => void;
  shareOrDownloadVaultJson: () => Promise<void>;
  importEncryptedVaultFile: (file: File, backdropToClose?: HTMLElement) => Promise<void>;
}

export class CloudWizardController {
  private readonly host: CloudWizardHost;
  private readonly els = {
    backdrop: byId('cloudOnboardingBackdrop'),
    closeBtn: byId<HTMLButtonElement>('closeOnboardingBtn'),
    providerSelectionGrid: byId('providerSelectionGrid'),
    downloadPortableBtn: byId<HTMLButtonElement>('downloadPortableBtn'),
    toStep2Btn: byId<HTMLButtonElement>('wizardToStep2Btn'),
    backToStep1Btn: byId<HTMLButtonElement>('wizardBackToStep1Btn'),
    selectedProviderTitle: byId('selectedProviderTitle'),
    osPathHintCode: byId('osPathHintCode'),
    copyPathHintBtn: byId<HTMLButtonElement>('copyPathHintBtn'),
    folderPickerHintText: byId('folderPickerHintText'),
    createCrypsySubfolderCb: byId<HTMLInputElement>('createCrypsySubfolderCb'),
    provisionPortableHtmlCb: byId<HTMLInputElement>('provisionPortableHtmlCb'),
    step2Error: byId('wizardStep2Error'),
    pickAndProvisionBtn: byId<HTMLButtonElement>('pickAndProvisionBtn'),
    connectedProviderHeading: byId('connectedProviderHeading'),
    connectedFolderDetails: byId('connectedFolderDetails'),
    unlinkBtn: byId<HTMLButtonElement>('unlinkCloudFolderBtn'),
    reprovisionBtn: byId<HTMLButtonElement>('reprovisionAssetsBtn'),
    finishBtn: byId<HTMLButtonElement>('finishOnboardingBtn'),
    step1: byId('wizardStep1'),
    step2: byId('wizardStep2'),
    step3: byId('wizardStep3'),
    desktopSyncBox: maybeById('wizardDesktopSyncBox'),
    mobileSyncBox: maybeById('wizardMobileSyncBox'),
    mobileShareVaultBtn: maybeById<HTMLButtonElement>('mobileShareVaultBtn'),
    mobileImportVaultInput: maybeById<HTMLInputElement>('mobileImportVaultInput'),
    mobileBackBtn: maybeById<HTMLButtonElement>('wizardMobileBackBtn'),
    mobileDoneBtn: maybeById<HTMLButtonElement>('wizardMobileDoneBtn'),
  };

  constructor(host: CloudWizardHost) {
    this.host = host;
    this.bindEvents();
  }

  public isOpen(): boolean {
    return !this.els.backdrop.classList.contains('hidden');
  }

  public close(): void {
    this.els.backdrop.classList.add('hidden');
  }

  public open(initialStep?: 1 | 2 | 3): void {
    if (initialStep !== undefined) {
      this.setStep(initialStep);
      this.els.backdrop.classList.remove('hidden');
      return;
    }
    if (CrypsyCloudSync.isNativeApp()) {
      this.setStep(2);
      this.els.backdrop.classList.remove('hidden');
      return;
    }
    const meta = CrypsyCloudSync.getSavedProviderMeta();
    if (CrypsyCloudSync.isConnected() && meta) {
      this.host.setSelectedProviderId(meta.providerId || 'onedrive');
      this.setStep(3);
    } else {
      this.setStep(1);
    }
    this.els.backdrop.classList.remove('hidden');
  }

  public setStep(stepNum: 1 | 2 | 3): void {
    document.querySelectorAll('[data-step-indicator]').forEach((el) => {
      const n = Number(el.getAttribute('data-step-indicator'));
      el.classList.toggle('active', n === stepNum);
    });

    this.els.step1.classList.toggle('hidden', stepNum !== 1);
    this.els.step2.classList.toggle('hidden', stepNum !== 2);
    this.els.step3.classList.toggle('hidden', stepNum !== 3);
    this.els.step2Error.classList.add('hidden');

    if (stepNum === 2) {
      const fsSupported =
        !CrypsyCloudSync.isNativeApp() && CrypsyCloudSync.isFileSystemAccessSupported();
      this.els.desktopSyncBox?.classList.toggle('hidden', !fsSupported);
      this.els.mobileSyncBox?.classList.toggle('hidden', fsSupported);
      this.els.mobileBackBtn?.classList.toggle('hidden', CrypsyCloudSync.isNativeApp());
      if (fsSupported) {
        const providerId = this.host.getSelectedProviderId();
        const provider = CrypsyCloudSync.PROVIDERS[providerId] ?? CrypsyCloudSync.PROVIDERS.custom;
        this.els.selectedProviderTitle.textContent = `Typical ${provider.name} Location on Your OS:`;
        this.els.osPathHintCode.textContent = CrypsyCloudSync.getProviderPathHint(providerId);
        this.els.folderPickerHintText.textContent = provider.folderHint;
      }
    }

    if (stepNum === 3) {
      const meta = CrypsyCloudSync.getSavedProviderMeta();
      if (meta) {
        this.els.connectedProviderHeading.textContent = `Connected to ${meta.providerName} (/${meta.folderName})`;
        this.els.connectedFolderDetails.textContent = `Your encrypted vault and portable app files are placed inside "${meta.parentFolderName}/${meta.folderName}".`;
      }
    }
  }

  private bindEvents(): void {
    this.els.closeBtn.addEventListener('click', () => this.close());
    this.els.backdrop.addEventListener('click', (e) => {
      if (e.target === this.els.backdrop) this.close();
    });

    this.els.providerSelectionGrid.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const card = target?.closest('[data-provider]');
      if (!card) return;
      const providerId = card.getAttribute('data-provider') as CloudProviderId | null;
      if (!providerId) return;
      this.host.setSelectedProviderId(providerId);
      this.els.providerSelectionGrid.querySelectorAll('.provider-card').forEach((c) => {
        c.classList.toggle('active', c === card);
      });
    });

    this.els.toStep2Btn.addEventListener('click', () => this.setStep(2));
    this.els.backToStep1Btn.addEventListener('click', () => this.setStep(1));
    this.els.mobileBackBtn?.addEventListener('click', () => this.setStep(1));
    this.els.mobileDoneBtn?.addEventListener('click', () => this.close());

    this.els.mobileShareVaultBtn?.addEventListener('click', () => {
      void this.host.shareOrDownloadVaultJson();
    });

    this.els.mobileImportVaultInput?.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      await this.host.importEncryptedVaultFile(file, this.els.backdrop);
      input.value = '';
    });

    this.els.copyPathHintBtn.addEventListener('click', async () => {
      const rawPath = (this.els.osPathHintCode.textContent ?? '').split('   or   ')[0]?.trim() ?? '';
      try {
        await navigator.clipboard.writeText(rawPath);
        this.els.copyPathHintBtn.textContent = 'Copied!';
        setTimeout(() => {
          this.els.copyPathHintBtn.textContent = 'Copy Path';
        }, 1500);
      } catch {
        // ignore clipboard failure
      }
    });

    this.els.pickAndProvisionBtn.addEventListener('click', async () => {
      this.els.step2Error.classList.add('hidden');
      const createSub = this.els.createCrypsySubfolderCb.checked;
      const includeHtml = this.els.provisionPortableHtmlCb.checked;

      try {
        await CrypsyCloudSync.pickCloudFolder(this.host.getSelectedProviderId(), createSub);

        const existingEnvelope = await CrypsyCloudSync.readVaultFromCloudFolder();
        if (existingEnvelope) {
          const loaded = await this.host.tryLoadEnvelope(existingEnvelope);
          if (!loaded) {
            this.close();
          }
        } else {
          await this.host.persistEncryptedVault();
        }

        try {
          await CrypsyCloudSync.provisionCloudFolderAssets(includeHtml);
        } catch (assetErr) {
          if (includeHtml) {
            await CrypsyCloudSync.provisionCloudFolderAssets(false);
            console.warn('Could not bundle Crypsy-Portable.html in browser:', assetErr);
          } else {
            throw assetErr;
          }
        }
        this.host.updateCloudStatusUI({ status: 'connected' });
        this.setStep(3);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        this.els.step2Error.textContent =
          err instanceof Error ? err.message : 'Could not link cloud folder.';
        this.els.step2Error.classList.remove('hidden');
      }
    });

    this.els.reprovisionBtn.addEventListener('click', async () => {
      try {
        await CrypsyCloudSync.provisionCloudFolderAssets(true);
        await this.host.persistEncryptedVault();
        this.els.reprovisionBtn.textContent = 'Files Updated!';
        setTimeout(() => {
          this.els.reprovisionBtn.textContent = 'Re-write Portable Files';
        }, 1600);
      } catch (e) {
        console.warn('Re-provision failed:', e);
        alert(e instanceof Error ? e.message : 'Could not update Crypsy-Portable.html.');
      }
    });

    this.els.unlinkBtn.addEventListener('click', async () => {
      await CrypsyCloudSync.unlinkCloudFolder();
      this.host.updateCloudStatusUI({ status: 'unlinked' });
      this.setStep(1);
    });

    this.els.finishBtn.addEventListener('click', () => this.close());

    this.els.downloadPortableBtn.addEventListener('click', async () => {
      try {
        const html = await CrypsyCloudSync.buildSelfContainedHtmlInBrowser();
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Crypsy-Portable.html';
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Could not build Crypsy-Portable.html.');
      }
    });
  }
}
