import { serverDisplayName } from "../components/serverDisplay";

export interface ServerSelectionIdentity {
  id?: string;
  name: string;
  country?: string | null;
  address: string;
  port: number;
  sni?: string | null;
  protocol?: string | null;
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
  /** "vless" (default) or "hysteria2"; uuid is the Hysteria2 auth then. */
  protocol?: string | null;
  obfs_password?: string | null;
  pin_sha256?: string | null;
  port_hopping?: string | null;
  ech_config_list?: string | null;
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
  protocol?: string | null;
}): string {
  return [
    server.address, server.port, server.uuid, server.sni ?? "", server.public_key ?? "",
    server.short_id ?? "", server.network ?? "", server.path ?? "", server.mode ?? "",
    server.host ?? "", server.service_name ?? "", serverProtocol(server),
  ].join("|");
}

export function stableServerId(
  server: Pick<ServerSelectionIdentity, "address" | "port" | "sni" | "protocol">,
): string {
  // Hysteria2 often shares host:port with a VLESS inbound (UDP vs TCP 443);
  // the prefix keeps them apart and leaves existing VLESS ids unchanged.
  const prefix = serverProtocol(server) === PROTOCOL_HYSTERIA2 ? "hy2:" : "";
  return `${prefix}${server.address}:${server.port}:${server.sni ?? ""}`;
}

export const PROTOCOL_VLESS = "vless";
export const PROTOCOL_HYSTERIA2 = "hysteria2";

/** Profiles cached before Hysteria2 support carry no protocol: VLESS. */
export function serverProtocol(server: { protocol?: string | null }): string {
  return server.protocol === PROTOCOL_HYSTERIA2 ? PROTOCOL_HYSTERIA2 : PROTOCOL_VLESS;
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
    value(a.extra) === value(b.extra) &&
    serverProtocol(a) === serverProtocol(b) &&
    value(a.obfs_password) === value(b.obfs_password) &&
    value(a.pin_sha256) === value(b.pin_sha256) &&
    value(a.port_hopping) === value(b.port_hopping) &&
    value(a.ech_config_list) === value(b.ech_config_list)
  );
}
