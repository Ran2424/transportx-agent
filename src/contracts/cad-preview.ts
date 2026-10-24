import { asRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import type { CadPreviewOptions } from './cad-types.ts';
import { optionalInteger, parseLayerName, parsePoint2, parseStringList, rejectUnknown } from './cad-validation.ts';

export function parsePreviewOptions(value: unknown, diagnostics: ContractDiagnostic[]): CadPreviewOptions | undefined {
  const record = asRecord(value);
  if (!record) { diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad.previewOptions', message: 'previewOptions must be an object.' })); return; }
  rejectUnknown(record, new Set(['bounds', 'layers', 'width', 'height']), 'cad.previewOptions', diagnostics);
  const result: CadPreviewOptions = {};
  if (record.bounds !== undefined) {
    const bounds = asRecord(record.bounds);
    if (bounds) rejectUnknown(bounds, new Set(['min', 'max']), 'cad.previewOptions.bounds', diagnostics);
    const min = parsePoint2(bounds?.min, 'cad.previewOptions.bounds.min', diagnostics);
    const max = parsePoint2(bounds?.max, 'cad.previewOptions.bounds.max', diagnostics);
    if (min && max && min[0] < max[0] && min[1] < max[1]) result.bounds = { min, max };
    else diagnostics.push(diagnostic({ code: 'out_of_range', path: 'cad.previewOptions.bounds', message: 'Preview bounds must have positive width and height.' }));
  }
  if (record.layers !== undefined) {
    const layers = parseStringList(record.layers, 'cad.previewOptions.layers', diagnostics, 64, (item, path) => parseLayerName(item, path, diagnostics));
    if (layers?.length) result.layers = layers;
    else diagnostics.push(diagnostic({ code: 'out_of_range', path: 'cad.previewOptions.layers', message: 'Select at least one layer.' }));
  }
  for (const key of ['width', 'height'] as const) {
    const size = optionalInteger(record, key, 'cad.previewOptions', diagnostics, 256);
    if (size !== undefined && size <= 4096) result[key] = size;
    else if (size !== undefined) diagnostics.push(diagnostic({ code: 'out_of_range', path: `cad.previewOptions.${key}`, message: 'Preview dimensions cannot exceed 4096 pixels.' }));
  }
  return result;
}
