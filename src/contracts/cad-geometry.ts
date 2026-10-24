import { asFiniteNumber, asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parsePoint2, parsePointArray } from './cad-validation.ts';
import type { CadPoint2 } from './cad-types.ts';

export type CadEntityGeometry =
  | { kind: 'line'; start: CadPoint2; end: CadPoint2 }
  | { kind: 'polyline'; points: CadPoint2[]; closed: boolean; bulges?: number[] }
  | { kind: 'circle'; center: CadPoint2; radius: number }
  | { kind: 'arc'; center: CadPoint2; radius: number; startAngle: number; endAngle: number }
  | { kind: 'text'; position: CadPoint2; height: number; rotationDeg: number }
  | { kind: 'point'; position: CadPoint2 }
  | { kind: 'insert'; name: string; position: CadPoint2; rotationDeg: number; scale: [number, number, number] };

export function parseCadGeometry(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadEntityGeometry | undefined {
  const record = asRecord(value);
  const point = (key: string) => parsePoint2(record?.[key], `${path}.${key}`, diagnostics);
  const number = (key: string) => asFiniteNumber(record?.[key]);
  if (record?.kind === 'line') {
    const start = point('start'), end = point('end');
    if (start && end) return { kind: 'line', start, end };
  } else if (record?.kind === 'polyline') {
    const points = parsePointArray(record.points, `${path}.points`, diagnostics, 1, 10_000);
    const bulges = record.bulges;
    if (points && typeof record.closed === 'boolean' && (bulges === undefined || Array.isArray(bulges) && bulges.length === points.length && bulges.every((n) => asFiniteNumber(n) !== null))) return { kind: 'polyline', points, closed: record.closed, ...(bulges ? { bulges } : {}) };
  } else if (record?.kind === 'circle' || record?.kind === 'arc') {
    const center = point('center'), radius = number('radius');
    if (center && radius !== null && radius > 0) {
      if (record.kind === 'circle') return { kind: 'circle', center, radius };
      const startAngle = number('startAngle'), endAngle = number('endAngle');
      if (startAngle !== null && endAngle !== null) return { kind: 'arc', center, radius, startAngle, endAngle };
    }
  } else if (record?.kind === 'point' || record?.kind === 'text' || record?.kind === 'insert') {
    const position = point('position');
    if (position) {
      if (record.kind === 'point') return { kind: 'point', position };
      const rotationDeg = number('rotationDeg');
      if (rotationDeg !== null && record.kind === 'text') {
        const height = number('height');
        if (height !== null && height > 0) return { kind: 'text', position, height, rotationDeg };
      } else if (rotationDeg !== null && record.kind === 'insert') {
        const name = asString(record.name, 255), scale = record.scale;
        if (name && Array.isArray(scale) && scale.length === 3 && scale.every((n) => asFiniteNumber(n) !== null)) return { kind: 'insert', name, position, rotationDeg, scale: scale as [number, number, number] };
      }
    }
  }
  diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Invalid or unsupported CAD entity geometry.' }));
}
