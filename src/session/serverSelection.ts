import { serverDisplayName } from "../components/serverDisplay";

export interface ServerSelectionIdentity {
  id?: string;
  name: string;
  country?: string | null;
  address: string;
  port: number;
  sni?: string | null;
}

export function stableServerId(server: ServerSelectionIdentity): string {
  return `${server.address}:${server.port}:${server.sni ?? ""}`;
}

export function serverSelectionKey(server: ServerSelectionIdentity): string {
  return serverDisplayName(server.name, server.country)
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function isSameServerSelection(
  a: ServerSelectionIdentity | null | undefined,
  b: ServerSelectionIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;

  const aStable = stableServerId(a);
  const bStable = stableServerId(b);
  const stableMatches =
    aStable === bStable ||
    a.id === bStable ||
    b.id === aStable ||
    (Boolean(a.id) && a.id === b.id);

  if (stableMatches) return true;

  const aKey = serverSelectionKey(a);
  const bKey = serverSelectionKey(b);
  return Boolean(aKey) && aKey === bKey;
}
