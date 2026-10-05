import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
  loadRoutingServiceDomains,
  ROUTING_SERVICES_DATABASE_VERSION,
} from "../session/routingDatabase";
import {
  displayRoutingDomain,
  isWithinDomain,
  loadRoutingSettings,
  looksLikeIpAddress,
  MAX_DOMAINS_PER_LIST,
  normalizeRoutingDomain,
  saveRoutingSettings,
  type RoutingSettings,
} from "../session/routingSettings";
import {
  reapplyRoutingSettings,
  useVpnRuntime,
} from "../session/vpnState";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import "./RoutingScreen.css";

type DomainListKey = "directDomains" | "proxyDomains";

function sameSettings(left: RoutingSettings, right: RoutingSettings): boolean {
  return (
    left.mode === right.mode &&
    left.selectAllServices === right.selectAllServices &&
    left.selectedServiceDomains.join("\n") === right.selectedServiceDomains.join("\n") &&
    left.excludedServiceDomains.join("\n") === right.excludedServiceDomains.join("\n") &&
    left.directDomains.join("\n") === right.directDomains.join("\n") &&
    left.proxyDomains.join("\n") === right.proxyDomains.join("\n")
  );
}

type DomainAddError = "routing_invalid_domain" | "routing_ip_not_supported" | "routing_list_full";

function DomainEditor({
  title,
  domains,
  onAdd,
  onRemove,
}: {
  title: string;
  domains: string[];
  onAdd: (value: string) => DomainAddError | null;
  onRemove: (domain: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<DomainAddError | null>(null);
  const invalid = error !== null;

  const submit = () => {
    const failure = onAdd(value);
    if (failure) {
      setError(failure);
      return;
    }
    setValue("");
    setError(null);
  };

  return (
    <section className="routing-section">
      <h2 className="routing-section__title">{title}</h2>
      <div className={`routing-domain-input ${invalid ? "routing-domain-input--invalid" : ""}`}>
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (invalid) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="example.com"
          spellCheck={false}
          autoCapitalize="none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          aria-label={t("routing_add_domain")}
          title={t("routing_add_domain")}
        >
          +
        </button>
      </div>
      {error && <div className="routing-domain-error">{t(error)}</div>}
      {domains.length > 0 && (
        <div className="routing-domain-list">
          {domains.map((domain) => (
            <div className="routing-domain-row" key={domain}>
              <span>{displayRoutingDomain(domain)}</span>
              <button
                type="button"
                onClick={() => onRemove(domain)}
                aria-label={t("routing_remove_domain")}
                title={t("routing_remove_domain")}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const MAX_VISIBLE_DATABASE_ROWS = 200;

export default function RoutingScreen({ onBack }: { onBack: () => void }) {
  const initial = useMemo(() => loadRoutingSettings(), []);
  const [draft, setDraft] = useState<RoutingSettings>(initial);
  const [saved, setSaved] = useState<RoutingSettings>(initial);
  const [applying, setApplying] = useState(false);
  const [database, setDatabase] = useState<string[]>([]);
  const [databaseVersion, setDatabaseVersion] = useState<string | null>(null);
  const [databaseLoading, setDatabaseLoading] = useState(false);
  const [databaseError, setDatabaseError] = useState(false);
  const [databaseReload, setDatabaseReload] = useState(0);
  const [query, setQuery] = useState("");
  // Uncontrolled after the first render: removing the last exception must
  // not fold the section the user is working in.
  const [advancedOpen, setAdvancedOpen] = useState(
    initial.directDomains.length > 0 || initial.proxyDomains.length > 0,
  );
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const runtime = useVpnRuntime();
  const dirty = !sameSettings(draft, saved);

  // Leaving the screen applies what was changed, whichever way the user
  // leaves (Back, another section, the window); nothing is lost silently.
  const pendingRef = useRef({ draft, saved });
  pendingRef.current = { draft, saved };
  useEffect(() => () => {
    const { draft: last, saved: lastSaved } = pendingRef.current;
    if (sameSettings(last, lastSaved)) return;
    saveRoutingSettings(last);
    void reapplyRoutingSettings().catch(() => {});
  }, []);

  useEffect(() => {
    if (
      draft.mode !== "selective" ||
      (database.length > 0 && databaseVersion === ROUTING_SERVICES_DATABASE_VERSION)
    ) {
      return;
    }
    let cancelled = false;
    setDatabaseLoading(true);
    setDatabaseError(false);
    loadRoutingServiceDomains()
      .then((domains) => {
        if (!cancelled) {
          setDatabase(domains);
          setDatabaseVersion(ROUTING_SERVICES_DATABASE_VERSION);
        }
      })
      .catch(() => {
        if (!cancelled) setDatabaseError(true);
      })
      .finally(() => {
        if (!cancelled) setDatabaseLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [database.length, databaseReload, databaseVersion, draft.mode]);

  const selectedSet = useMemo(
    () => new Set(draft.selectedServiceDomains),
    [draft.selectedServiceDomains],
  );
  const excludedSet = useMemo(
    () => new Set(draft.excludedServiceDomains),
    [draft.excludedServiceDomains],
  );
  const isDatabaseDomainSelected = (domain: string) =>
    draft.selectAllServices ? !excludedSet.has(domain) : selectedSet.has(domain);

  const databaseView = useMemo(() => {
    const selected: string[] = [];
    const unselected: string[] = [];
    let matches = 0;
    const queryDomain = deferredQuery ? normalizeRoutingDomain(deferredQuery) : null;
    for (const domain of database) {
      if (
        deferredQuery &&
        !domain.includes(deferredQuery) &&
        !(domain.includes("xn--") && displayRoutingDomain(domain).includes(deferredQuery)) &&
        !(queryDomain && isWithinDomain(queryDomain, domain))
      ) {
        continue;
      }
      matches++;
      const target = isDatabaseDomainSelected(domain) ? selected : unselected;
      if (target.length < MAX_VISIBLE_DATABASE_ROWS) target.push(domain);
    }
    return {
      domains: [...selected, ...unselected].slice(0, MAX_VISIBLE_DATABASE_ROWS),
      matches,
    };
  }, [
    database,
    deferredQuery,
    draft.selectAllServices,
    excludedSet,
    selectedSet,
  ]);

  const selectedDatabaseCount = useMemo(() => {
    if (draft.selectAllServices) {
      let excluded = 0;
      for (const domain of database) {
        if (excludedSet.has(domain)) excluded++;
      }
      return Math.max(0, database.length - excluded);
    }
    let selected = 0;
    for (const domain of database) {
      if (selectedSet.has(domain)) selected++;
    }
    return selected;
  }, [database, draft.selectAllServices, excludedSet, selectedSet]);

  // A zone ("ru", "yandex.ru") carries the services inside it along, so
  // the checkboxes always show where each site goes; a service can still be
  // switched on its own afterwards (the most specific entry wins).
  const toggleDatabaseDomain = (domain: string) => {
    const affected = database.filter((item) => isWithinDomain(item, domain));
    if (!affected.includes(domain)) affected.push(domain);
    setDraft((current) => {
      if (current.selectAllServices) {
        const excluded = new Set(current.excludedServiceDomains);
        const exclude = !excluded.has(domain);
        for (const item of affected) {
          if (exclude) excluded.add(item);
          else excluded.delete(item);
        }
        return { ...current, excludedServiceDomains: [...excluded].sort() };
      }
      const selected = new Set(current.selectedServiceDomains);
      const select = !selected.has(domain);
      for (const item of affected) {
        if (select) selected.add(item);
        else selected.delete(item);
      }
      return { ...current, selectedServiceDomains: [...selected].sort() };
    });
  };

  const updateDomainList = (
    target: DomainListKey,
    action: "add" | "remove",
    rawDomain: string,
  ): DomainAddError | null => {
    const domain = normalizeRoutingDomain(rawDomain);
    if (!domain) {
      return looksLikeIpAddress(rawDomain) ? "routing_ip_not_supported" : "routing_invalid_domain";
    }
    if (
      action === "add" &&
      !draft[target].includes(domain) &&
      draft[target].length >= MAX_DOMAINS_PER_LIST
    ) {
      return "routing_list_full";
    }
    const opposite: DomainListKey =
      target === "directDomains" ? "proxyDomains" : "directDomains";
    setDraft((current) => {
      const targetSet = new Set(current[target]);
      if (action === "add") targetSet.add(domain);
      else targetSet.delete(domain);
      return {
        ...current,
        [target]: [...targetSet].sort(),
        [opposite]:
          action === "add"
            ? current[opposite].filter((item) => item !== domain)
            : current[opposite],
      };
    });
    return null;
  };

  const apply = async () => {
    if (!dirty || applying) return;
    setApplying(true);
    const normalized = saveRoutingSettings(draft);
    setDraft(normalized);
    setSaved(normalized);
    try {
      await reapplyRoutingSettings();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="routing-root">
      <div className="routing-topbar">
        <button className="routing-topbar__back" onClick={onBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="routing-topbar__title">{t("routing_title")}</span>
        <div className="routing-topbar__spacer" />
      </div>

      <ScrollEdgeAffordance className="routing-content">
        <section className="routing-section">
          <h2 className="routing-section__title">{t("routing_mode")}</h2>
          <div className="routing-segmented">
            <button
              type="button"
              className={draft.mode === "blocked_only" ? "routing-segmented__active" : ""}
              onClick={() => setDraft((current) => ({ ...current, mode: "blocked_only" }))}
            >
              {t("routing_mode_blocked_only")}
            </button>
            <button
              type="button"
              className={draft.mode === "selective" ? "routing-segmented__active" : ""}
              onClick={() => setDraft((current) => ({ ...current, mode: "selective" }))}
            >
              {t("routing_mode_selective")}
            </button>
            <button
              type="button"
              className={draft.mode === "all_vpn" ? "routing-segmented__active" : ""}
              onClick={() => setDraft((current) => ({ ...current, mode: "all_vpn" }))}
            >
              {t("routing_mode_all_vpn")}
            </button>
          </div>
          {draft.mode === "blocked_only" && (
            <div className="routing-auto">
              <div className="routing-auto__icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </div>
              <div className="routing-auto__content">
                <div className="routing-auto__title">{t("routing_auto_title")}</div>
                <div className="routing-auto__description">{t("routing_auto_description")}</div>
                <div className="routing-auto__database">{t("routing_auto_database")}</div>
              </div>
            </div>
          )}
        </section>

        {draft.mode === "selective" && (
          <section className="routing-section routing-selective">
            <div className="routing-selective__header">
              <div>
                <h2 className="routing-section__title">{t("routing_selective_title")}</h2>
                <p className="routing-section__hint">{t("routing_selective_description")}</p>
              </div>
              <span className="routing-selective__count">
                {t("routing_selected")}: {selectedDatabaseCount}/{database.length || "…"}
              </span>
            </div>

            <div className="routing-search">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("routing_search")}
                spellCheck={false}
              />
            </div>

            <div className="routing-selective__actions">
              <button
                type="button"
                disabled={databaseLoading || database.length === 0}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    selectAllServices: true,
                    selectedServiceDomains: [],
                    excludedServiceDomains: [],
                  }))
                }
              >
                {t("routing_select_all")}
              </button>
              <button
                type="button"
                disabled={databaseLoading || database.length === 0}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    selectAllServices: false,
                    selectedServiceDomains: [],
                    excludedServiceDomains: [],
                  }))
                }
              >
                {t("routing_clear")}
              </button>
            </div>

            {databaseLoading && (
              <div className="routing-database-state">{t("routing_loading_database")}</div>
            )}
            {databaseError && (
              <button
                type="button"
                className="routing-database-state routing-database-state--error"
                onClick={() => {
                  setDatabaseError(false);
                  setDatabase([]);
                  setDatabaseVersion(null);
                  setDatabaseReload((value) => value + 1);
                }}
              >
                {t("routing_database_error")}
              </button>
            )}
            {!databaseLoading && !databaseError && databaseView.domains.length === 0 && (
              <div className="routing-database-state">{t("routing_no_results")}</div>
            )}
            {databaseView.domains.length > 0 && (
              <div className="routing-database-list">
                {databaseView.domains.map((domain) => (
                  <label className="routing-database-row" key={domain}>
                    <input
                      type="checkbox"
                      checked={isDatabaseDomainSelected(domain)}
                      onChange={() => toggleDatabaseDomain(domain)}
                    />
                    <span>{displayRoutingDomain(domain)}</span>
                  </label>
                ))}
              </div>
            )}
            {databaseView.matches > MAX_VISIBLE_DATABASE_ROWS && (
              <div className="routing-database-limit">{t("routing_results_limited")}</div>
            )}
          </section>
        )}

        <details
          className="routing-advanced"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>{t("routing_additional")}</summary>
          <section className="routing-section routing-section--intro">
            <h2 className="routing-section__title">{t("routing_exceptions")}</h2>
            <p className="routing-section__hint">{t("routing_exceptions_hint")}</p>
          </section>
          <DomainEditor
            title={t("routing_always_direct")}
            domains={draft.directDomains}
            onAdd={(domain) => updateDomainList("directDomains", "add", domain)}
            onRemove={(domain) => updateDomainList("directDomains", "remove", domain)}
          />
          <DomainEditor
            title={t("routing_always_vpn")}
            domains={draft.proxyDomains}
            onAdd={(domain) => updateDomainList("proxyDomains", "add", domain)}
            onRemove={(domain) => updateDomainList("proxyDomains", "remove", domain)}
          />
        </details>
      </ScrollEdgeAffordance>

      <div className="routing-actions">
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || applying || runtime.connecting || runtime.disconnecting}
        >
          {applying ? t("routing_applying") : t("routing_apply")}
        </button>
      </div>
    </div>
  );
}
