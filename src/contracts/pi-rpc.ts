/** Only these Pi extension UI requests wait for a client response. */
export function isPiExtensionDialogRequest(request: { type?: unknown; method?: unknown }): boolean {
  return request.type === 'extension_ui_request'
    && ['select', 'confirm', 'input', 'editor'].includes(String(request.method));
}

export type PiMessageQueue = { steering: string[]; followUp: string[] };

/** queue_update is a complete replacement, including empty queues. */
export function parsePiMessageQueue(value: unknown): PiMessageQueue | null {
  if (!value || typeof value !== 'object') return null;
  const { steering, followUp } = value as Record<string, unknown>;
  if (!Array.isArray(steering) || !steering.every((text) => typeof text === 'string')
    || !Array.isArray(followUp) || !followUp.every((text) => typeof text === 'string')) return null;
  return { steering: [...steering], followUp: [...followUp] };
}
