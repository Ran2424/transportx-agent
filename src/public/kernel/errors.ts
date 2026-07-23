/**
 * Re-export shim. The contract authority for `AppError` is
 * `src/contracts/errors.ts`. New code should import directly from
 * `../../contracts/index.js`.
 */
export { appError, toAppError, protocolError } from '../../contracts/errors.ts';
export type { AppError, AppErrorCategory } from '../../contracts/errors.ts';
