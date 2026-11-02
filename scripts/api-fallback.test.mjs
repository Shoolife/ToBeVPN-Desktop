import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Run the production client with an in-memory session and HTTP transport.
// No real endpoints or credentials are used by these regression tests.
const source = await readFile(new URL("../src/api/client.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replaceAll("import.meta.env.DEV", "false"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const PRIMARY = "https://primary.test/";
const FALLBACK = "https://fallback.test/function?region=test&u=";
const tokens = {
  access_token: "renewed-access",
  refresh_token: "renewed-refresh",
  expires_in: 1800,
  refresh_expires_in: 86400,
  is_linked: true,
};
const json = (body, status = 200) => Response.json(body, { status });
const tokenResponse = () => json({ success: true, data: tokens });

function createClient({ fetch, expired = false, fallback = FALLBACK }) {
  let session = {
    deviceId: "test-device",
    isLinked: true,
    accessToken: "initial-access",
    refreshToken: "initial-refresh",
    accessTokenExpiresAt: Date.now() + (expired ? -1000 : 60000),
    refreshTokenExpiresAt: Date.now() + 86400000,
  };
  const calls = [];
  const diagnostics = [];
  let cleared = 0;
  const transport = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const isFallback = url.hostname === "fallback.test";
    const target = isFallback ? new URL(`https://${url.searchParams.get("u")}`) : url;
    const call = {
      url, target, isFallback, method: init.method ?? "GET",
      headers: new Headers(init.headers), body: init.body,
    };
    calls.push(call);
    return fetch(call);
  };
  const imports = {
    "@tauri-apps/plugin-http": { fetch: transport },
    "./config": {
      BOT_API_BASE_URL: PRIMARY,
      BOT_API_FALLBACK_URL: fallback,
      CONTROL_PLANE_BYPASS_HOSTS: ["primary.test", "fallback.test"],
    },
    "../session/fingerprint": {
      getDeviceFingerprint: async () => ({ hwid: "test-hwid", userAgent: "ToBeVPN/test" }),
    },
    "../session/diagnostics": {
      recordDiagnosticEvent: (...event) => diagnostics.push(event),
    },
    "../session/store": {
      getSession: () => session,
      getSessionGeneration: () => 1,
      hasValidAccessToken: (value) => Boolean(value.accessToken && value.accessTokenExpiresAt > Date.now()),
      hasValidRefreshToken: (value) => Boolean(value.refreshToken && value.refreshTokenExpiresAt > Date.now()),
      updateSession: (patch) => (session = { ...session, ...patch }),
      updateSessionFromTokens: (value) => (session = {
        ...session,
        accessToken: value.access_token,
        refreshToken: value.refresh_token,
        accessTokenExpiresAt: Date.now() + value.expires_in * 1000,
        refreshTokenExpiresAt: Date.now() + value.refresh_expires_in * 1000,
      }),
      clearSessionTokens: () => {
        cleared += 1;
        session = { ...session, accessToken: null, refreshToken: null };
      },
    },
    "../session/secureSession": {
      clearSecureSession: async () => {},
      persistCurrentSessionSecrets: async () => {},
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
    URL, Headers, Response, AbortController, TextEncoder, crypto, performance, Error,
    console: { warn() {} },
    clearTimeout,
    window: { setTimeout: (callback, ms) => setTimeout(callback, ms === 400 ? 0 : ms) },
  }, { filename: "src/api/client.ts" });
  return { api: exports, calls, diagnostics, session: () => session, cleared: () => cleared };
}

test("expired session refreshes through fallback before an authenticated GET", async () => {
  const client = createClient({
    expired: true,
    fetch: (call) => {
      if (!call.isFallback) throw new Error("Primary network unavailable");
      if (call.target.pathname === "/api/device/refresh") return tokenResponse();
      assert.equal(call.headers.get("X-Proxy-Authorization"), "Bearer renewed-access");
      assert.equal(call.headers.has("Authorization"), false);
      return json({ response: [] });
    },
  });
  const result = await client.api.getNodes();
  assert.deepEqual(result, { response: [] });
  const refresh = client.calls.filter((call) => call.target.pathname === "/api/device/refresh");
  assert.equal(refresh.length, 2);
  assert.deepEqual(refresh.map((call) => call.isFallback), [false, true]);
  assert.equal(refresh[1].method, "POST");
  assert.equal(refresh[1].body, refresh[0].body);
  assert.deepEqual(JSON.parse(refresh[1].body), { refresh_token: "initial-refresh" });
  assert.equal(refresh[1].url.searchParams.get("region"), "test");
  assert.equal(refresh[1].url.searchParams.get("u"), "primary.test/api/device/refresh");
  assert.equal(client.session().accessToken, "renewed-access");
  assert.equal(client.cleared(), 0);
});

test("bootstrap falls back with the same device identity and JSON body", async () => {
  const client = createClient({ fetch: (call) => {
    if (!call.isFallback) throw new Error("Primary network unavailable");
    return tokenResponse();
  } });
  await client.api.bootstrapDeviceSession();
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].method, "POST");
  assert.equal(client.calls[1].body, client.calls[0].body);
  assert.deepEqual(JSON.parse(client.calls[1].body), { device_id: "test-device", platform: "desktop" });
  assert.equal(client.calls[1].headers.get("Content-Type"), "application/json");
});

test("a primary HTTP 403 can use the session fallback", async () => {
  const client = createClient({ fetch: (call) => call.isFallback
    ? tokenResponse()
    : json({ message: "Route blocked" }, 403) });
  await client.api.bootstrapDeviceSession();
  assert.deepEqual(client.calls.map((call) => call.isFallback), [false, true]);
});

test("an authoritative primary HTTP 401 is not replayed through fallback", async () => {
  const client = createClient({ fetch: () => json({ message: "Invalid session" }, 401) });
  await assert.rejects(client.api.bootstrapDeviceSession(), { status: 401 });
  assert.equal(client.calls.length, 1);
});

test("writes use the known fallback route once, with proxy authorization", async () => {
  const client = createClient({ fetch: (call) => {
    if (!call.isFallback) throw new Error("Primary network unavailable");
    return json({ success: true, response: [] });
  } });
  await client.api.getNodes();
  client.calls.length = 0;
  const body = { device_name: "test PC", device_type: "pc", platform: "windows" };
  await client.api.registerDevice(body);
  assert.equal(client.calls.length, 1);
  const [call] = client.calls;
  assert.equal(call.isFallback, true);
  assert.equal(call.method, "POST");
  assert.deepEqual(JSON.parse(call.body), body);
  assert.equal(call.headers.get("X-Proxy-Authorization"), "Bearer initial-access");
  assert.equal(call.headers.has("Authorization"), false);
});

test("a write the fallback proxy cannot route is retried once on primary", async () => {
  const client = createClient({ fetch: (call) => {
    if (call.method === "GET") {
      if (!call.isFallback) throw new Error("Primary network unavailable");
      return json({ response: [] });
    }
    return call.isFallback ? json({ message: "Unknown route" }, 404) : json({ success: true });
  } });
  await client.api.getNodes();
  client.calls.length = 0;
  const body = { device_name: "test PC", device_type: "pc", platform: "windows" };
  await client.api.registerDevice(body);
  assert.deepEqual(client.calls.map((call) => call.isFallback), [true, false]);
  assert.deepEqual(JSON.parse(client.calls[1].body), body);
  assert.equal(client.calls[1].headers.get("Authorization"), "Bearer initial-access");
});

test("a gateway 403 on a fallback write is retried once on primary", async () => {
  const client = createClient({ fetch: (call) => {
    if (call.method === "GET") {
      if (!call.isFallback) throw new Error("Primary network unavailable");
      return json({ response: [] });
    }
    return call.isFallback
      ? json({ errorCode: 403, errorMessage: "Forbidden: Not authorized", errorType: "ClientError" }, 403)
      : json({ success: true });
  } });
  await client.api.getNodes();
  client.calls.length = 0;
  await client.api.registerDevice({ device_name: "test PC", device_type: "pc", platform: "windows" });
  assert.deepEqual(client.calls.map((call) => call.isFallback), [true, false]);
});

test("a failed mutation is not replayed on another route", async () => {
  const client = createClient({ fetch: () => { throw new Error("Response lost"); } });
  await assert.rejects(client.api.unlinkDevice({ device_id: "another-device" }), /Network request failed/);
  assert.equal(client.calls.length, 1);
});

test("a failed write on the known fallback is not replayed on primary", async () => {
  const client = createClient({ fetch: (call) => {
    if (!call.isFallback || call.method === "POST") throw new Error("Response lost");
    return json({ response: [] });
  } });
  await client.api.getNodes();
  client.calls.length = 0;
  await assert.rejects(client.api.unlinkDevice({ device_id: "another-device" }), /Network request failed/);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].isFallback, true);
});

test("fallback transport failure preserves the stored session", async () => {
  const client = createClient({ expired: true, fetch: () => { throw new Error("Network unavailable"); } });
  await assert.rejects(client.api.ensureDeviceSession(), /Network request failed/);
  assert.equal(client.calls.length, 2);
  assert.equal(client.cleared(), 0);
  assert.equal(client.session().refreshToken, "initial-refresh");
});

test("a technical proxy HTTP 403 does not invalidate the refresh token", async () => {
  const client = createClient({ expired: true, fetch: (call) => {
    if (!call.isFallback) throw new Error("Primary network unavailable");
    return json({ errorCode: 403, errorMessage: "Forbidden: Not authorized", errorType: "ClientError" }, 403);
  } });
  await assert.rejects(client.api.ensureDeviceSession(), /Fallback route rejected request/);
  assert.equal(client.calls.length, 2);
  assert.equal(client.cleared(), 0);
});

test("a missing fallback keeps a single primary session request", async () => {
  const client = createClient({ fallback: null, expired: true, fetch: () => { throw new Error("Network unavailable"); } });
  await assert.rejects(client.api.ensureDeviceSession(), /Network request failed/);
  assert.equal(client.calls.length, 1);
  assert.equal(client.cleared(), 0);
});
