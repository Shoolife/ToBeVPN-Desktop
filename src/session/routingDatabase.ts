import { normalizeRoutingDomain } from "./routingSettings";

let routingDomainsPromise: Promise<string[]> | null = null;
export const ROUTING_SERVICES_DATABASE_VERSION = "ru-services-wide-2026-06-15";

export function loadRoutingServiceDomains(): Promise<string[]> {
  if (routingDomainsPromise) return routingDomainsPromise;
  routingDomainsPromise = fetch(
    `/routing/ru-services.txt?v=${ROUTING_SERVICES_DATABASE_VERSION}`,
    {
      cache: "no-store",
    },
  )
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Routing database request failed: ${response.status}`);
      }
      const text = await response.text();
      const domains = new Set<string>();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim().toLowerCase();
        const rule = trimmed.startsWith("domain:")
          ? trimmed.slice(7)
          : trimmed.startsWith("full:")
            ? trimmed.slice(5)
            : trimmed;
        const domain = normalizeRoutingDomain(rule);
        if (domain) domains.add(domain);
      }
      return [...domains].sort();
    })
    .catch((error) => {
      routingDomainsPromise = null;
      throw error;
    });
  return routingDomainsPromise;
}
