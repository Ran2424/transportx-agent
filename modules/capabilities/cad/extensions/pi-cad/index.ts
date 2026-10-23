import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const Point = Type.Array(Type.Number(), { minItems: 2, maxItems: 2 });
const Layer = Type.String({ minLength: 1, maxLength: 255 });
const Handle = Type.String({ pattern: '^[0-9A-F]{1,16}$' });

const Selector = Type.Union([
  Type.Object({ kind: Type.Literal('handle'), handle: Handle }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('layer'), layer: Layer, entityType: Type.Optional(Type.String({ maxLength: 40 })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('bounds'), layer: Type.Optional(Layer), entityType: Type.Optional(Type.String({ maxLength: 40 })), min: Point, max: Point }, { additionalProperties: false }),
]);

const Operation = Type.Union([
  Type.Object({ op: Type.Literal('move'), selector: Selector, dx: Type.Number(), dy: Type.Number() }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('copy'), selector: Selector, dx: Type.Number(), dy: Type.Number(), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('delete'), selector: Selector }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('setLayer'), selector: Selector, layer: Layer }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('drawPolyline'), layer: Layer, points: Type.Array(Point, { minItems: 2, maxItems: 10_000 }), closed: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('drawText'), layer: Layer, position: Point, text: Type.String({ maxLength: 500 }), height: Type.Number({ exclusiveMinimum: 0 }), rotationDeg: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('drawHatch'), layer: Layer, boundary: Type.Array(Point, { minItems: 3, maxItems: 10_000 }) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('insertBlock'), layer: Layer, name: Type.String({ maxLength: 255 }), position: Point, rotationDeg: Type.Optional(Type.Number()), scale: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }, { additionalProperties: false }),
]);

const Target = Type.Union([
  Type.Object({ kind: Type.Literal('epsg'), code: Type.String({ pattern: '^EPSG:[0-9]{4,6}$', maxLength: 40, description: 'Projected CRS code in EPSG:<number> form, for example EPSG:32651. Units must be metres.' }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('local'), origin: Point, rotationDeg: Type.Optional(Type.Number()), scale: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }, { additionalProperties: false }),
], { description: 'Required for kind="from-geojson"; omit for kind="edit" and kind="import".' });

const DrawSchema = Type.Object({
  protocol: Type.Literal('tau-cad'),
  version: Type.Literal('1.0'),
  kind: Type.Union([Type.Literal('from-geojson'), Type.Literal('edit'), Type.Literal('import')], {
    description: 'from-geojson creates a new drawing from GeoJSON; edit modifies an existing drawing; import registers an existing DXF.',
  }),
  fileId: Type.Optional(Type.String({
    pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    description: 'Stable drawing id. Required for kind="edit"; optional for from-geojson/import.',
  })),
  sourcePath: Type.Optional(Type.String({
    maxLength: 1000,
    description: 'Session-relative .geojson/.json path for from-geojson, or .dxf path for import. Omit for edit.',
  })),
  target: Type.Optional(Target),
  units: Type.Optional(Type.Union([Type.Literal('m'), Type.Literal('mm')], {
    description: 'Drawing units. from-geojson currently supports only "m".',
  })),
  layerKey: Type.Optional(Type.String({ maxLength: 120, description: 'GeoJSON property used as the layer mapping key. Defaults to "kind".' })),
  layerMap: Type.Optional(Type.Record(Type.String({ maxLength: 120 }), Layer, {
    description: 'Required for from-geojson: maps GeoJSON property values to DXF layer names.',
  })),
  labelField: Type.Optional(Type.String({ maxLength: 120, description: 'GeoJSON property copied into text labels.' })),
  labelLayer: Type.Optional(Layer),
  fillLayers: Type.Optional(Type.Array(Layer, { maxItems: 64 })),
  repairInvalid: Type.Optional(Type.Boolean()),
  template: Type.Optional(Type.String({ maxLength: 120 })),
  title: Type.Optional(Type.String({ maxLength: 300 })),
  baseRevision: Type.Optional(Type.Integer({
    minimum: 0,
    description: 'Required only for kind="edit"; must equal the current revision from cad_inspect. Omit for from-geojson/import.',
  })),
  operations: Type.Optional(Type.Array(Operation, {
    minItems: 1,
    maxItems: 200,
    description: 'Required only for kind="edit"; ordered drawing operations.',
  })),
  dryRun: Type.Optional(Type.Boolean({ description: 'When true, validate and return the plan without writing DXF or preview files.' })),
}, { additionalProperties: false });

const InspectSchema = Type.Object({
  protocol: Type.Literal('tau-cad'),
  version: Type.Literal('1.0'),
  fileId: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' })),
  path: Type.Optional(Type.String({ maxLength: 1000 })),
  include: Type.Optional(Type.Array(Type.Union([
    Type.Literal('summary'), Type.Literal('layers'), Type.Literal('entities'),
    Type.Literal('blocks'), Type.Literal('units'), Type.Literal('extents'), Type.Literal('textStyles'),
  ]), { maxItems: 7 })),
  selector: Type.Optional(Selector),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(Type.String({ maxLength: 160 })),
}, { additionalProperties: false });

const VerifySchema = Type.Object({
  protocol: Type.Literal('tau-cad'),
  version: Type.Literal('1.0'),
  fileId: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' })),
  path: Type.Optional(Type.String({ maxLength: 1000 })),
  revision: Type.Optional(Type.Integer({ minimum: 0 })),
  policy: Type.Optional(Type.Union([Type.Literal('traffic-v1'), Type.Literal('strict')])),
}, { additionalProperties: false });

type ToolResult = Record<string, unknown>;

function cadHost() {
  const endpoint = process.env.TAU_CAD_ENDPOINT;
  const sessionId = process.env.TAU_CAD_SESSION_ID;
  const token = process.env.TAU_CAD_TOKEN;
  if (!endpoint || !sessionId || !token) throw new Error('CAD Host bridge is unavailable for this session.');
  return { endpoint, sessionId, token };
}

async function call(path: string, body: Record<string, unknown>): Promise<ToolResult> {
  const host = cadHost();
  const response = await fetch(`${host.endpoint}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: host.sessionId, token: host.token }),
  });
  const payload = await response.json() as { result?: unknown; error?: string };
  if (!response.ok || payload.result === undefined) throw new Error(payload.error || 'CAD Host request failed.');
  return payload.result as ToolResult;
}

function messages(result: ToolResult): string {
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return [...diagnostics, ...warnings]
    .map((item) => item && typeof item === 'object' && 'message' in item ? String((item as { message: unknown }).message) : '')
    .filter(Boolean)
    .slice(0, 6)
    .join('；');
}

function drawText(result: ToolResult): string {
  if (result.ok === false) return `CAD 未完成：${messages(result) || '请查看诊断。'}`;
  if (result.dryRun === true) {
    const plan = result.plan as { operationCount?: number; matchedCount?: number; wouldCreate?: number; sampleHandles?: string[] } | undefined;
    return `CAD dry-run：操作 ${plan?.operationCount ?? 0}，命中 ${plan?.matchedCount ?? 0}，预计新增 ${plan?.wouldCreate ?? 0}。样例句柄：${(plan?.sampleHandles || []).slice(0, 10).join(', ') || '无'}。`;
  }
  const drawing = result.drawing as { path?: string; revision?: number; units?: string; entityCount?: number; layerCount?: number; sha256?: string } | undefined;
  const preview = result.preview as { png?: string; pdf?: string } | undefined;
  return `CAD 已提交：${drawing?.path || '未知路径'}，revision ${drawing?.revision ?? '?'}，单位 ${drawing?.units || '?'}，实体 ${drawing?.entityCount ?? '?'}，图层 ${drawing?.layerCount ?? '?'}。预览：${preview?.png || '无'}${preview?.pdf ? `；PDF：${preview.pdf}` : ''}。${messages(result) ? `注意：${messages(result)}` : ''}`;
}

function inspectText(result: ToolResult): string {
  const summary = result.summary as { units?: string | null; entityCount?: number; layerCount?: number; extents?: unknown; sha256?: string } | undefined;
  const warning = messages(result);
  return `CAD 查询：单位 ${summary?.units ?? '未知'}，实体 ${summary?.entityCount ?? '?'}，图层 ${summary?.layerCount ?? '?'}。${summary?.sha256 ? `sha256 ${summary.sha256.slice(0, 12)}…。` : ''}${warning ? `警告：${warning}` : ''}`;
}

function verifyText(result: ToolResult): string {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const failed = checks.filter((item) => item && typeof item === 'object' && (item as { status?: string }).status === 'fail').length;
  const warned = checks.filter((item) => item && typeof item === 'object' && (item as { status?: string }).status === 'warning').length;
  return `CAD 校验：${result.ok === true ? '通过' : '未通过'}；${checks.length} 项检查，${failed} 项失败，${warned} 项警告。${messages(result) ? `诊断：${messages(result)}` : ''}`;
}

export default function cadExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'cad_inspect',
    label: 'CAD 查询',
    description: 'Read-only DXF inspection: current revision, units, layers, entities, handles, blocks, text styles and extents. Call this before cad_draw kind="edit" to obtain the exact baseRevision.',
    parameters: InspectSchema,
    async execute(_toolCallId, params) {
      const result = await call('/api/internal/cad/inspect', params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: inspectText(result) }],
        details: { kind: 'tau-cad-inspect' as const, result },
      };
    },
  });

  pi.registerTool({
    name: 'cad_draw',
    label: 'CAD 制图',
    description: [
      'Create, edit or import a 2D DXF. Choose exactly one mode via kind:',
      '- from-geojson: new drawing; requires sourcePath, target and layerMap; do NOT send baseRevision.',
      '- edit: existing drawing; requires fileId, baseRevision and operations; do NOT send sourcePath, target or layerMap.',
      '- import: existing DXF; requires sourcePath ending in .dxf; do NOT send baseRevision or operations.',
      'Call cad_inspect before edit, use dryRun=true for bulk changes, then call cad_verify after writing.',
      'target.code must be written as "EPSG:32651", not "32651".',
    ].join(' '),
    parameters: DrawSchema,
    async execute(_toolCallId, params) {
      const result = await call('/api/internal/cad/draw', params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: drawText(result) }],
        details: { kind: 'tau-cad-draw' as const, result, canvas: result.canvas },
      };
    },
  });

  pi.registerTool({
    name: 'cad_verify',
    label: 'CAD 校验',
    description: 'Reopen a DXF and verify units, layers, closed boundaries, degenerate/duplicate geometry, extents and unsupported entities. Call this after cad_draw writes a revision.',
    parameters: VerifySchema,
    async execute(_toolCallId, params) {
      const result = await call('/api/internal/cad/verify', params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: verifyText(result) }],
        details: { kind: 'tau-cad-verify' as const, result },
      };
    },
  });
}
