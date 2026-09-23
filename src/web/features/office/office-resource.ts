export const OFFICE_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export type OfficeResourceErrorCode = 'forbidden' | 'missing' | 'version-changed' | 'too-large' | 'length-required' | 'http';

export class OfficeResourceError extends Error {
  readonly code: OfficeResourceErrorCode;
  readonly status?: number;

  constructor(code: OfficeResourceErrorCode, status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function responseError(response: Response) {
  if (response.status === 403) return new OfficeResourceError('forbidden', response.status);
  if (response.status === 404) return new OfficeResourceError('missing', response.status);
  if (response.status === 409) return new OfficeResourceError('version-changed', response.status);
  if (response.status === 413) return new OfficeResourceError('too-large', response.status);
  return new OfficeResourceError('http', response.status);
}

export async function loadOfficeResource(url: string, signal: AbortSignal) {
  const head = await fetch(url, { method: 'HEAD', cache: 'no-store', signal });
  if (!head.ok) throw responseError(head);
  const contentLength = head.headers.get('content-length');
  if (!contentLength || !/^\d+$/.test(contentLength)) throw new OfficeResourceError('length-required');
  if (Number(contentLength) > OFFICE_PREVIEW_MAX_BYTES) throw new OfficeResourceError('too-large');

  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw responseError(response);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > OFFICE_PREVIEW_MAX_BYTES) throw new OfficeResourceError('too-large');
  return bytes;
}
