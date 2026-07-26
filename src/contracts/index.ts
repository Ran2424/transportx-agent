/**
 * Project-owned contract surface. Import only from here so Extension, Server
 * and Web Feature code agree on every type and every diagnostic.
 *
 * Layer rules:
 *   - This folder must NOT import React, Node-only modules (fs, path, ...),
 *     MapLibre or DOM typings. Server-only IO (e.g. SessionProjection) lives
 *     under `src/server/` and re-exports the pure helpers.
 *   - Versioned parsers expose structured diagnostics. Existing `value | null`
 *     parser names remain as compatibility entry points where they existed.
 */
export * from './diagnostic.ts';
export * from './version.ts';
export * from './common.ts';
export * from './errors.ts';
export * from './session.ts';
export * from './task.ts';
export * from './geo.ts';
export * from './citation.ts';
export * from './bridge.ts';
export * from './capabilities.ts';
