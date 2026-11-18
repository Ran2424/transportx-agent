export type DeliveryStatus = 'submitted' | 'needs_review' | 'incomplete';

export function messageDelivery(message: {
  role?: unknown;
  delivery?: unknown;
  evidenceCompletion?: unknown;
} | undefined): DeliveryStatus | null {
  if (message?.role !== 'assistant') return null;
  const delivery = message.delivery as { status?: unknown } | null | undefined;
  if (delivery?.status === 'submitted' || delivery?.status === 'needs_review' || delivery?.status === 'incomplete')
    return delivery.status;
  // Compatibility for messages recorded by archived evidence modules.
  switch (message.evidenceCompletion) {
    case 'verified': return 'submitted';
    case 'missing': return 'needs_review';
    case 'incomplete': return 'incomplete';
    default: return null;
  }
}
