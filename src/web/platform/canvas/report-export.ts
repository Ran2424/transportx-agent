import i18n from '../../i18n';
import { appKernel } from '../../app/composition-root';

async function imageDataUrl(image: HTMLImageElement, fallbackError: Error) {
  if (image.complete && image.naturalWidth && image.naturalHeight) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      context.drawImage(image, 0, 0);
      return canvas.toDataURL();
    } catch { /* Fetch below when the image cannot be copied from the preview. */ }
  }
  const response = await fetch(image.src);
  if (!response.ok) throw fallbackError;
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(i18n.t('workspace.imageConvertFailed')));
    reader.readAsDataURL(blob);
  });
}

export async function downloadDocument(url: string) {
  const desktop = window as Window & { transportxDesktop?: { download(url: string): Promise<string> } };
  if (desktop.transportxDesktop) await desktop.transportxDesktop.download(url);
  else window.location.assign(url);
}

export async function exportReportPdf(report: HTMLElement, title: string) {
  const clone = report.cloneNode(true) as HTMLElement;
  const images = [...report.querySelectorAll<HTMLImageElement>('img')];
  const clonedImages = [...clone.querySelectorAll<HTMLImageElement>('img')];
  await Promise.all(images.map(async (image, index) => {
    if (!image.src || image.src.startsWith('data:')) return;
    clonedImages[index]?.setAttribute('src', await imageDataUrl(image, new Error(i18n.t('workspace.imageLoadFailed', { name: image.alt || index + 1 }))));
  }));
  const detail = await appKernel.commands.report.exportPdf(title, clone.outerHTML);
  await downloadDocument(detail.url);
}
