import { readFile } from "node:fs/promises";

const ROOT_CONFIG = "src-tauri/tauri.conf.json";
const SCALE_SOURCE = "src/session/interfaceScale.ts";
const PLATFORM_CONFIGS = [
  "src-tauri/tauri.linux.conf.json",
  "src-tauri/tauri.windows.conf.json",
];

const scaleSource = await readFile(SCALE_SOURCE, "utf8");
const readScaleConstant = (name) => {
  const match = scaleSource.match(new RegExp(`export const ${name} = ([0-9.]+);`));
  if (!match) throw new Error(`${SCALE_SOURCE}: numeric constant ${name} is missing`);
  return Number(match[1]);
};

const design = {
  width: readScaleConstant("DESIGN_WINDOW_WIDTH"),
  height: readScaleConstant("DESIGN_WINDOW_HEIGHT"),
  defaultScale: readScaleConstant("INTERFACE_SCALE_DEFAULT"),
  minScale: readScaleConstant("INTERFACE_SCALE_MIN"),
  maxScale: readScaleConstant("INTERFACE_SCALE_MAX"),
  windowScaleBase: readScaleConstant("WINDOW_SCALE_BASE"),
};

const expectedWindow = {
  width: Math.round(design.width * design.defaultScale * design.windowScaleBase),
  height: Math.round(design.height * design.defaultScale * design.windowScaleBase),
  minWidth: Math.round(design.width * design.minScale * design.windowScaleBase),
  minHeight: Math.round(design.height * design.minScale * design.windowScaleBase),
  maxWidth: Math.round(design.width * design.maxScale * design.windowScaleBase),
  maxHeight: Math.round(design.height * design.maxScale * design.windowScaleBase),
  resizable: false,
};

async function readWindowConfig(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  const window = config?.app?.windows?.[0];
  if (!window) throw new Error(`${path}: app.windows[0] is missing`);
  return window;
}

const failures = [];
for (const path of [ROOT_CONFIG, ...PLATFORM_CONFIGS]) {
  const window = await readWindowConfig(path);
  for (const [field, expected] of Object.entries(expectedWindow)) {
    if (window[field] !== expected) {
      failures.push(`${path}: ${field}=${JSON.stringify(window[field])}, expected ${expected}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Window scaling configuration is inconsistent:\n${failures.join("\n")}`);
}

console.log("Window scaling bounds are consistent in root, Linux, and Windows configs.");
