/** Shared CAD contracts; implementation details stay in the domain parsers. */
export * from './cad-types.ts';
export { parseCadDrawRequestStructured, parseCadInspectRequestStructured, parseCadVerifyRequestStructured } from './cad-requests.ts';
export { parseCadDrawResultStructured, parseCadInspectResultStructured, parseCadVerifyResultStructured } from './cad-results.ts';
export { parseCadDrawingManifestStructured } from './cad-manifest.ts';
