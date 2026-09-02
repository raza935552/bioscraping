// Idempotency keys — every outbound side effect claims one before acting.
// BullMQ jobId gets the same key so queue-level dedup matches row-level dedup.

export function messageKey(leadId: string, touchNumber: number, channel: string): string {
  return `msg:${leadId}:${touchNumber}:${channel.toLowerCase().replace(/\s+/g, "-")}`;
}

export function signupKey(normalizedEmail: string): string {
  return `signup:${normalizedEmail}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Identity key for cross-motion dedup: platform + handle, normalized. */
export function handleKey(platform: string, handle: string): string {
  return `${platform.trim().toLowerCase()}:${handle.trim().toLowerCase().replace(/^@/, "")}`;
}
