/**
 * Panel UUID to keep after an identity update. short_uuid survives the panel
 * 3.x upgrade and names the same subscription; a 3.x account can omit its
 * UUID, so a cached UUID is kept only while the subscription is the same one
 * (an anonymous profile's UUID must not stick to a different account).
 */
export function mergePanelUserUuid(
  previousUuid: string | null | undefined,
  previousShortUuid: string | null | undefined,
  incomingUuid: string | null | undefined,
  incomingShortUuid: string | null | undefined,
): string | null {
  const incoming = typeof incomingUuid === "string" ? incomingUuid.trim() : "";
  if (incoming) return incoming;
  if (!previousUuid) return null;
  const incomingShort = typeof incomingShortUuid === "string" ? incomingShortUuid.trim() : "";
  return !incomingShort || incomingShort === previousShortUuid ? previousUuid : null;
}
