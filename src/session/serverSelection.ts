import { serverDisplayName } from "../components/serverDisplay";

export interface ServerSelectionIdentity {
  id?: string;
  name: string;
  country?: string | null;
  address: string;
  port: number;
  sni?: string | null;
}

export interface ServerVpnConfigIdentity {
  address: string;
  port: number;
  uuid: string;
  flow?: string | null;
  security?: string | null;
  sni?: string | null;
  fingerprint?: string | null;
  public_key?: string | null;
  short_id?: string | null;
  network?: string | null;
  path?: string | null;
  mode?: string | null;
  spx?: string | null;
}

export function stableServerId(
  server: Pick<ServerSelectionIdentity, "address" | "port" | "sni">,
): string {
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

/**
 * Compares only fields that affect the XRay outbound. Display metadata can
 * change without requiring a tunnel restart.
 */
export function hasSameVpnConfig(
  a: ServerVpnConfigIdentity | null | undefined,
  b: ServerVpnConfigIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  const value = (input: string | null | undefined) => input ?? "";
  return (
    a.address === b.address &&
    a.port === b.port &&
    a.uuid === b.uuid &&
    value(a.flow) === value(b.flow) &&
    value(a.security) === value(b.security) &&
    value(a.sni) === value(b.sni) &&
    value(a.fingerprint) === value(b.fingerprint) &&
    value(a.public_key) === value(b.public_key) &&
    value(a.short_id) === value(b.short_id) &&
    value(a.network) === value(b.network) &&
    value(a.path) === value(b.path) &&
    value(a.mode) === value(b.mode) &&
    value(a.spx) === value(b.spx)
  );
}
