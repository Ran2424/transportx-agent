import type { XlsxCopyResult } from '@silurus/ooxml/xlsx';
import type { DocumentFormat } from '../../platform/canvas/document-state';

type OfficeFormat = Extract<DocumentFormat, 'docx' | 'xlsx' | 'pptx'>;
export type OfficePosition = { current: number; total: number; label?: string };
export type OfficeViewerEvents = {
  onError(error: Error): void;
  onPosition(position: OfficePosition): void;
  onNotes(notes: string): void;
};

export type OfficeViewerController = {
  format: OfficeFormat;
  findText(query: string): Promise<number>;
  findNext(): Promise<void>;
  findPrev(): Promise<void>;
  clearFind(): void;
  zoomIn(): void | Promise<void>;
  zoomOut(): void | Promise<void>;
  fitWidth(): void | Promise<void>;
  fitPage(): void | Promise<void>;
  copySelection?(): Promise<XlsxCopyResult>;
  destroy(): void;
};

const resourceLimits = {
  maxArchiveEntryBytes: 64 * 1024 * 1024,
  maxTotalInflatedBytes: 192 * 1024 * 1024,
  maxArchiveEntries: 4096,
};

const imageResources = {
  decodedByteBudget: 96 * 1024 * 1024,
  strategy: 'adaptive' as const,
  resolution: 'display' as const,
};

export async function createOfficeViewer(format: OfficeFormat, container: HTMLElement, bytes: ArrayBuffer, events: OfficeViewerEvents): Promise<OfficeViewerController> {
  if (format === 'docx') {
    const { DocxScrollViewer } = await import('@silurus/ooxml/docx');
    const viewer = new DocxScrollViewer(container, {
      mode: 'main', useGoogleFonts: false, cjkFallback: 'sc', enableTextSelection: true,
      enableElementSelection: true, enableHyperlinks: false, comments: true,
      resourceLimits, imageResources, onError: events.onError,
      onVisiblePageChange: (index, total) => events.onPosition({ current: index + 1, total }),
    });
    try {
      await viewer.load(bytes);
      events.onPosition({ current: viewer.topVisiblePage + 1, total: viewer.pageCount });
      return {
        format, findText: async (query) => (await viewer.findText(query)).length,
        findNext: async () => { await viewer.findNext(); }, findPrev: async () => { await viewer.findPrev(); },
        clearFind: () => viewer.clearFind(), zoomIn: () => viewer.zoomIn(), zoomOut: () => viewer.zoomOut(),
        fitWidth: () => viewer.fitWidth(), fitPage: () => viewer.fitPage(), destroy: () => viewer.destroy(),
      };
    } catch (error) { viewer.destroy(); throw error; }
  }

  if (format === 'xlsx') {
    const { XlsxViewer } = await import('@silurus/ooxml/xlsx');
    const viewer = new XlsxViewer(container, {
      mode: 'main', useGoogleFonts: false, cjkFallback: 'sc', enableElementSelection: true,
      enableHyperlinks: false, comments: true, resourceLimits, imageResources,
      onError: events.onError,
      onSheetChange: (index, total) => events.onPosition({ current: index + 1, total, label: viewer.sheetNames[index] }),
    });
    try {
      await viewer.load(bytes);
      events.onPosition({ current: viewer.sheetIndex + 1, total: viewer.sheetCount, label: viewer.sheetNames[viewer.sheetIndex] });
      return {
        format, findText: async (query) => (await viewer.findText(query)).length,
        findNext: async () => { await viewer.findNext(); }, findPrev: async () => { await viewer.findPrev(); },
        clearFind: () => viewer.clearFind(), zoomIn: () => viewer.zoomIn(), zoomOut: () => viewer.zoomOut(),
        fitWidth: () => viewer.fitWidth(), fitPage: () => viewer.fitPage(),
        copySelection: () => viewer.copySelection(), destroy: () => viewer.destroy(),
      };
    } catch (error) { viewer.destroy(); throw error; }
  }

  const { PptxPresentation, PptxScrollViewer } = await import('@silurus/ooxml/pptx');
  const presentation = await PptxPresentation.load(bytes, {
    mode: 'main', useGoogleFonts: false, cjkFallback: 'sc', resourceLimits,
  });
  let viewer: Omit<InstanceType<typeof PptxScrollViewer>, 'load'> | null = null;
  try {
    viewer = PptxScrollViewer.fromPresentation(container, presentation, {
      imageResources, enableTextSelection: true, enableElementSelection: true,
      enableHyperlinks: false, comments: true, onError: events.onError,
      onVisibleSlideChange: (index, total) => {
        events.onPosition({ current: index + 1, total });
        events.onNotes(presentation.getNotes(index) || '');
      },
    });
    events.onPosition({ current: viewer.topVisibleSlide + 1, total: viewer.slideCount });
    events.onNotes(presentation.getNotes(viewer.topVisibleSlide) || '');
    const pptxViewer = viewer;
    return {
      format, findText: async (query) => (await pptxViewer.findText(query)).length,
      findNext: async () => { await pptxViewer.findNext(); }, findPrev: async () => { await pptxViewer.findPrev(); },
      clearFind: () => pptxViewer.clearFind(), zoomIn: () => pptxViewer.zoomIn(), zoomOut: () => pptxViewer.zoomOut(),
      fitWidth: () => pptxViewer.fitWidth(), fitPage: () => pptxViewer.fitPage(),
      destroy: () => { pptxViewer.destroy(); presentation.destroy(); },
    };
  } catch (error) {
    viewer?.destroy();
    presentation.destroy();
    throw error;
  }
}
