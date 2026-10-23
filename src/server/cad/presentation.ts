import crypto from 'node:crypto';
import type { CadDrawingManifestV1, CadInspectResultV1, CadPreviewV1 } from '../../contracts/cad.js';
import { parseCanvasPresentation, type CanvasPresentationOperation } from '../../contracts/canvas.js';
import { CAD_CANVAS_ADAPTER_ID } from '../../contracts/canvas-cad.js';
import { serviceError } from './files.js';

// Canvas expresses presentation intent. Only the drawing store assigns revisions.
export function cadPresentation(manifest: CadDrawingManifestV1, summary?: Pick<CadInspectResultV1['summary'], 'units' | 'layerCount' | 'entityCount'>, operation: CanvasPresentationOperation = 'present', preview?: CadPreviewV1, historicalRevision?: number) {
  const entry = manifest.revisions.find((item) => item.revision === (historicalRevision ?? manifest.currentRevision))!;
  const canvas = parseCanvasPresentation({
    protocol: 'pi-canvas', version: '1.0', presentationId: `cad_pres_${crypto.randomUUID()}`,
    adapterId: CAD_CANVAS_ADAPTER_ID, kind: 'cad', viewId: `cad:${manifest.fileId}${historicalRevision !== undefined ? `@r${historicalRevision}` : ''}`,
    revision: entry.revision, operation, title: historicalRevision === undefined ? manifest.title : `${manifest.title} · r${historicalRevision}`,
    resources: [{ scope: 'session-file', path: entry.path }],
    payload: { format: 'dxf', path: entry.path, sha256: entry.sha256, units: summary ? summary.units : entry.units !== undefined ? entry.units : manifest.units,
      ...(summary ? { layerCount: summary.layerCount, entityCount: summary.entityCount } : {}),
      ...(preview ? { preview: preview.png } : {}) },
    generatedAt: new Date().toISOString(),
  });
  if (!canvas) throw serviceError('CAD Canvas presentation is invalid.', 500, 'cad.canvas_invalid');
  return canvas;
}
