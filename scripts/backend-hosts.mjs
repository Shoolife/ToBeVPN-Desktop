#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(SCRIPT_DIR);
const STATE_PATH = join(ROOT_DIR, "src-tauri", ".backend-hosts-backup.json");
const FILES = [
  "src-tauri/tauri.conf.json",
  "src-tauri/capabilities/default.json",
];
const PLACEHOLDERS = {
  __BOT_API_HOST__: "BOT_API_HOST",
  __PANEL_HOST__: "PANEL_HOST",
  __SUBSCRIPTION_HOST__: "SUBSCRIPTION_HOST",
  __FALLBACK_BOT_HOST__: "FALLBACK_BOT_HOST",
  __FALLBACK_SUBS_HOST__: "FALLBACK_SUBS_HOST",
};

function fail(message) {
  throw new Error(message);
}

function parseDotEnv(source) {
  const result = new Map();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    result.set(match[1], value);
  }
  return result;
}

async function loadDotEnv() {
  try {
    return parseDotEnv(await readFile(join(ROOT_DIR, ".env"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}

function envValue(dotEnv, ...names) {
  for (const name of names) {
    const value = process.env[name] ?? dotEnv.get(name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function validHostname(hostname) {
  if (hostname.length > 253 || hostname.endsWith(".")) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname)) {
    return hostname.split(".").every((part) => Number(part) <= 255);
  }
  return hostname.split(".").every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

function normalizeHost(raw, name, fallback = "") {
  const value = raw || fallback;
  if (!value) fail(`${name} is required (environment or .env)`);
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) {
    fail(`${name} contains whitespace or control characters`);
  }

  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    fail(`${name} is not a valid HTTPS host or URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password
  ) {
    fail(`${name} must be an HTTPS URL without embedded credentials`);
  }
  if (!validHostname(url.hostname.toLowerCase())) {
    fail(`${name} contains an invalid hostname`);
  }
  return url.host.toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(path, content, mode) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode });
    await chmod(tempPath, mode);
    const handle = await open(tempPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.files !== "object") {
      fail("backend-host backup has an unsupported format");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restore() {
  const state = await readState();
  if (!state) {
    const contents = await Promise.all(
      FILES.map((file) => readFile(join(ROOT_DIR, file), "utf8")),
    );
    const missing = Object.keys(PLACEHOLDERS).filter(
      (placeholder) => !contents.some((content) => content.includes(placeholder)),
    );
    if (missing.length) {
      fail(`cannot restore backend hosts: backup is absent and placeholders are missing: ${missing.join(", ")}`);
    }
    return;
  }

  for (const file of FILES) {
    const entry = state.files[file];
    if (
      !entry ||
      typeof entry.content !== "string" ||
      !Number.isInteger(entry.mode) ||
      sha256(entry.content) !== entry.sha256
    ) {
      fail(`backend-host backup is corrupt for ${file}`);
    }
  }
  for (const file of FILES) {
    const entry = state.files[file];
    await atomicWrite(join(ROOT_DIR, file), entry.content, entry.mode);
  }
  await unlink(STATE_PATH);
  console.log("Restored backend host placeholders.");
}

async function resolveHosts() {
  const dotEnv = await loadDotEnv();
  return {
    BOT_API_HOST: normalizeHost(
      envValue(dotEnv, "BOT_API_HOST", "VITE_BOT_API_URL"),
      "BOT_API_HOST",
    ),
    PANEL_HOST: normalizeHost(
      envValue(dotEnv, "PANEL_HOST", "VITE_PANEL_URL"),
      "PANEL_HOST",
    ),
    SUBSCRIPTION_HOST: normalizeHost(
      envValue(dotEnv, "SUBSCRIPTION_HOST", "VITE_SUBSCRIPTION_URL"),
      "SUBSCRIPTION_HOST",
      "example.invalid",
    ),
    FALLBACK_BOT_HOST: normalizeHost(
      envValue(dotEnv, "FALLBACK_BOT_HOST", "VITE_FALLBACK_BOT_DOMAIN"),
      "FALLBACK_BOT_HOST",
      "example.invalid",
    ),
    FALLBACK_SUBS_HOST: normalizeHost(
      envValue(dotEnv, "FALLBACK_SUBS_HOST", "VITE_FALLBACK_SUBS_DOMAIN"),
      "FALLBACK_SUBS_HOST",
      "example.invalid",
    ),
  };
}

async function inject() {
  const hosts = await resolveHosts();
  if (await readState()) {
    fail("backend hosts are already injected; finish the active build or run restore-host first");
  }

  const state = { version: 1, files: {} };
  for (const file of FILES) {
    const path = join(ROOT_DIR, file);
    const content = await readFile(path, "utf8");
    const fileStat = await stat(path);
    state.files[file] = {
      content,
      mode: fileStat.mode & 0o777,
      sha256: sha256(content),
    };
  }
  for (const placeholder of Object.keys(PLACEHOLDERS)) {
    const count = FILES.reduce(
      (total, file) =>
        total + state.files[file].content.split(placeholder).length - 1,
      0,
    );
    if (count === 0) fail(`source placeholder is missing: ${placeholder}`);
  }

  await mkdir(dirname(STATE_PATH), { recursive: true });
  await atomicWrite(STATE_PATH, `${JSON.stringify(state)}\n`, 0o600);

  try {
    for (const file of FILES) {
      const entry = state.files[file];
      let output = entry.content;
      for (const [placeholder, hostName] of Object.entries(PLACEHOLDERS)) {
        output = output.split(placeholder).join(hosts[hostName]);
      }
      JSON.parse(output);
      await atomicWrite(join(ROOT_DIR, file), output, entry.mode);
    }
  } catch (error) {
    await restore().catch(() => undefined);
    throw error;
  }
  console.log("Injected validated backend host allowlist.");
}

const command = process.argv[2];
try {
  if (command === "inject") await inject();
  else if (command === "restore") await restore();
  else fail("usage: backend-hosts.mjs <inject|restore>");
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
