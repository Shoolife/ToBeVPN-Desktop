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
  host?: string | null;
  alpn?: string | null;
  header_type?: string | null;
  service_name?: string | null;
  extra?: string | null;
}

/** Full identity of a server profile. Ids built from address:port:sni can
 *  repeat: different servers may share one endpoint, and one endpoint can
 *  carry several transports. */
export function serverProfileKey(server: {
  address: string;
  port: number;
  uuid: string;
  sni?: string | null;
  public_key?: string | null;
  short_id?: string | null;
  network?: string | null;
  path?: string | null;
  mode?: string | null;
  host?: string | null;
  service_name?: string | null;
}): string {
  return [
    server.address, server.port, server.uuid, server.sni ?? "", server.public_key ?? "",
    server.short_id ?? "", server.network ?? "", server.path ?? "", server.mode ?? "",
    server.host ?? "", server.service_name ?? "",
  ].join("|");
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
 * The entry of a fresh server list that is the user's selection. The
 * subscription can hand out another host/SNI for the same server on every
 * request, and different servers can share one endpoint (address:port:SNI),
 * so a plain `.find(isSameServerSelection)` could take a neighbour that
 * merely shares the endpoint, or miss the server after a host change.
 * Preference: same name and endpoint, then the same name (host rotated),
 * then the same endpoint (server renamed).
 */
export function findSameServer<T extends ServerSelectionIdentity>(
  selection: ServerSelectionIdentity | null | undefined,
  candidates: readonly T[],
): T | null {
  if (!selection) return null;
  const key = serverSelectionKey(selection);
  const stable = stableServerId(selection);
  const sameName = (candidate: T) => Boolean(key) && serverSelectionKey(candidate) === key;
  const sameEndpoint = (candidate: T) => {
    const candidateStable = stableServerId(candidate);
    return (
      candidateStable === stable ||
      selection.id === candidateStable ||
      candidate.id === stable ||
      (Boolean(selection.id) && selection.id === candidate.id)
    );
  };
  return (
    candidates.find((candidate) => sameName(candidate) && sameEndpoint(candidate)) ??
    candidates.find(sameName) ??
    candidates.find(sameEndpoint) ??
    null
  );
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
    value(a.spx) === value(b.spx) &&
    value(a.host) === value(b.host) &&
    value(a.alpn) === value(b.alpn) &&
    value(a.header_type) === value(b.header_type) &&
    value(a.service_name) === value(b.service_name) &&
    value(a.extra) === value(b.extra)
  );
}
