/**
 * Crypsy — Cloud Folder Onboarding Wizard Controller
 * Manages the 3-step BYOC cloud folder linking, portable HTML provisioning,
 * and mobile share/import wizard modal.
 */

import {
  PROVIDERS,
  buildSelfContainedHtmlInBrowser,
  getProviderPathHint,
  getSavedProviderMeta,
  isConnected,
  isFileSystemAccessSupported,
  isNativeApp,
  markRemoteStampAccepted,
  pickCloudFolder,
  provisionCloudFolderAssets,
  readVaultFromCloudFolder,
  unlinkCloudFolder,
} from '../vault/cloud-sync';
import type {
  CloudConnectionStatus,
  CloudFileStamp,
  CloudProviderId,
  EncryptedEnvelope,
} from '../types';
import { byId } from '../utils';

export interface CloudWizardHost {
  getSelectedProviderId: () => CloudProviderId;
  setSelectedProviderId: (id: CloudProviderId) => void;
  onLoadCloudEnvelope: (
    envelope: EncryptedEnvelope,
    stamp?: CloudFileStamp
  ) => Promise<'applied' | 'needs_unlock' | 'cancelled'>;
  persistEncryptedVault: () => Promise<void>;
  updateCloudStatusUI: (status?: CloudConnectionStatus) => void;
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
    desktopSyncBox: byId('wizardDesktopSyncBox'),
    mobileSyncBox: byId('wizardMobileSyncBox'),
    mobileShareVaultBtn: byId<HTMLButtonElement>('mobileShareVaultBtn'),
    mobileImportVaultInput: byId<HTMLInputElement>('mobileImportVaultInput'),
    mobileBackBtn: byId<HTMLButtonElement>('wizardMobileBackBtn'),
    mobileDoneBtn: byId<HTMLButtonElement>('wizardMobileDoneBtn'),
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
    if (isNativeApp()) {
      this.setStep(2);
      this.els.backdrop.classList.remove('hidden');
      return;
    }
    const meta = getSavedProviderMeta();
    if (isConnected() && meta) {
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
      const fsSupported = !isNativeApp() && isFileSystemAccessSupported();
      this.els.desktopSyncBox.classList.toggle('hidden', !fsSupported);
      this.els.mobileSyncBox.classList.toggle('hidden', fsSupported);
      this.els.mobileBackBtn.classList.toggle('hidden', isNativeApp());
      if (fsSupported) {
        const providerId = this.host.getSelectedProviderId();
        const provider = PROVIDERS[providerId] ?? PROVIDERS.custom;
        this.els.selectedProviderTitle.textContent = `Typical ${provider.name} Location on Your OS:`;
        this.els.osPathHintCode.textContent = getProviderPathHint(providerId);
        this.els.folderPickerHintText.textContent = provider.folderHint;
      }
    }

    if (stepNum === 3) {
      const meta = getSavedProviderMeta();
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
    this.els.mobileBackBtn.addEventListener('click', () => this.setStep(1));
    this.els.mobileDoneBtn.addEventListener('click', () => this.close());

    this.els.mobileShareVaultBtn.addEventListener('click', () => {
      void this.host.shareOrDownloadVaultJson();
    });

    this.els.mobileImportVaultInput.addEventListener('change', async (e) => {
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
        await pickCloudFolder(this.host.getSelectedProviderId(), createSub);

        const readRes = await readVaultFromCloudFolder();
        if (readRes.status === 'corrupt' || readRes.status === 'error') {
          this.els.step2Error.textContent = readRes.message;
          this.els.step2Error.classList.remove('hidden');
          this.host.updateCloudStatusUI('connected');
          return;
        }

        if (readRes.status === 'ok') {
          const outcome = await this.host.onLoadCloudEnvelope(readRes.envelope, readRes.stamp);
          if (outcome === 'cancelled') {
            await unlinkCloudFolder();
            this.host.updateCloudStatusUI('unlinked');
            return;
          }
          if (outcome === 'applied') {
            markRemoteStampAccepted(readRes.stamp);
          } else {
            this.host.updateCloudStatusUI('connected');
            this.close();
            return;
          }
        } else if (readRes.status === 'not_found') {
          await this.host.persistEncryptedVault();
        } else {
          this.els.step2Error.textContent = 'Folder permission was not granted.';
          this.els.step2Error.classList.remove('hidden');
          return;
        }

        try {
          await provisionCloudFolderAssets(includeHtml);
        } catch (assetErr) {
          if (includeHtml) {
            await provisionCloudFolderAssets(false);
            console.warn('Could not bundle Crypsy-Portable.html in browser:', assetErr);
          } else {
            throw assetErr;
          }
        }
        this.host.updateCloudStatusUI('connected');
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
        await provisionCloudFolderAssets(true);
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
      await unlinkCloudFolder();
      this.host.updateCloudStatusUI('unlinked');
      this.setStep(1);
    });

    this.els.finishBtn.addEventListener('click', () => this.close());

    this.els.downloadPortableBtn.addEventListener('click', async () => {
      try {
        const html = await buildSelfContainedHtmlInBrowser();
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
