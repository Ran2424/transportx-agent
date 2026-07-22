/**
 * Re-export shim. The contract authority is `src/contracts/geo.ts`.
 * `visualization-host.ts` and `session-visualization-store.ts` continue to
 * import from this path; new code should use
 * `import { ... } from '../../contracts/index.js'`.
 */
export {
  parseGeoScene,
  parseVisualizationEnvelope,
  isFeatureCollection,
  getVisualizationFromToolResult,
  parseGeoSceneStructured,
  parseVisualizationEnvelopeStructured,
  visualizationEnvelope,
  acceptEnvelopeRevision,
  formatSceneValidationErrors,
  VISUALIZATION_PROTOCOL,
  VISUALIZATION_VERSION,
} from '../../../contracts/geo.ts';
export type {
  GeoJsonGeometry,
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  GeoView,
  GeoVisualValue,
  GeoSource,
  GeoLayer,
  GeoSceneSnapshot,
  GeoEnvelopeOperation,
  VisualizationEnvelope,
  ValidationIssue,
  ValidationResult,
  GeoDiagnostic,
  GeoParseResult,
} from '../../../contracts/geo.ts';
