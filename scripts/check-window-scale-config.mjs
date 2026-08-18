import { readFile } from "node:fs/promises";

const ROOT_CONFIG = "src-tauri/tauri.conf.json";
const SCALE_SOURCE = "src/session/interfaceScale.ts";
const APP_SOURCE = "src/App.tsx";
const NATIVE_SOURCE = "src-tauri/src/lib.rs";
const APP_STYLES = "src/App.css";
const LINUX_CONFIG = "src-tauri/tauri.linux.conf.json";
const PLATFORM_CONFIGS = [LINUX_CONFIG, "src-tauri/tauri.windows.conf.json"];

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
  titlebar: readScaleConstant("DESKTOP_TITLEBAR_HEIGHT"),
};
design.outerHeight = design.height + design.titlebar;

// Every size in the Tauri configs is logical, so the desktop's display scaling
// multiplies it — that is what makes the app the same apparent size at 100%
// and at 200%.
const baseWidth = Math.round(design.width * design.defaultScale * design.windowScaleBase);
const baseHeight = Math.round(design.outerHeight * design.defaultScale * design.windowScaleBase);
// Both platforms draw the same in-window titlebar, so both windows are the
// same size. A per-platform height is what made Linux and Windows differ.
const expectedWindow = {
  width: baseWidth,
  height: baseHeight,
  resizable: false,
};
const rejectedBounds = ["minWidth", "minHeight", "maxWidth", "maxHeight"];

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
  // The frontend owns the bounds through the 0.7..1.3 slider. Config bounds
  // would additionally clamp the resize and fight it at the extremes.
  for (const field of rejectedBounds) {
    if (field in window) {
      failures.push(`${path}: ${field} must be omitted, the interface scale owns the bounds`);
    }
  }
}

for (const path of PLATFORM_CONFIGS) {
  const window = await readWindowConfig(path);
  for (const [field, expected] of Object.entries({
    decorations: false,
    transparent: true,
    shadow: false,
  })) {
    if (window[field] !== expected) {
      failures.push(`${path}: ${field}=${JSON.stringify(window[field])}, expected ${expected}`);
    }
  }
}

const appSource = await readFile(APP_SOURCE, "utf8");
// The animation drives setSize in physical pixels, but the target is derived
// from the logical size times the live scale factor.
if (!appSource.includes("new PhysicalSize(")) {
  failures.push(`${APP_SOURCE}: native resize must use PhysicalSize`);
}
if (!appSource.includes("physicalTargetFor(")) {
  failures.push(`${APP_SOURCE}: the physical target must be derived from the logical size`);
}
if (!appSource.includes("await win.scaleFactor()")) {
  failures.push(`${APP_SOURCE}: the conversion needs the window's own scale factor`);
}
if (!appSource.includes("await win.innerSize()")) {
  failures.push(`${APP_SOURCE}: resize animation must start from the physical inner size`);
}
if (!appSource.includes("win.onScaleChanged")) {
  failures.push(`${APP_SOURCE}: moving between monitors must recompute the physical size`);
}
if (!appSource.includes("mon.workArea.size.toLogical(")) {
  failures.push(`${APP_SOURCE}: the monitor fit must compare logical sizes with a logical target`);
}
// The titlebar sits inside the scaled frame, so its compensation has to be
// part of the design height rather than a constant added afterwards.
if (!appSource.includes("DESIGN_WINDOW_OUTER_HEIGHT * windowScale")) {
  failures.push(`${APP_SOURCE}: window height must scale the outer design height`);
}
if (appSource.includes("DESIGN_WINDOW_HEIGHT")) {
  failures.push(
    `${APP_SOURCE}: the window spans the titlebar too, so it must use ` +
      `DESIGN_WINDOW_OUTER_HEIGHT everywhere`,
  );
}

// The CSS offset that pushes the content below the titlebar is the other half
// of the same number; if they drift apart the content is cropped again.
const appStyles = await readFile(APP_STYLES, "utf8");
if (!new RegExp(`\\.app--desktop-frame \\.app__content \\{[^}]*top: ${design.titlebar}px`).test(appStyles)) {
  failures.push(
    `${APP_STYLES}: .app--desktop-frame .app__content must start at ` +
      `${design.titlebar}px, matching DESKTOP_TITLEBAR_HEIGHT`,
  );
}

const nativeSource = await readFile(NATIVE_SOURCE, "utf8");
// A physical startup size would ignore the desktop's display scaling and open
// the window at a fraction of its intended size on HiDPI screens.
if (/set_size\(\s*tauri::PhysicalSize/.test(nativeSource)) {
  failures.push(`${NATIVE_SOURCE}: the startup size must stay logical, from tauri.conf.json`);
}

// The apparent size must not change with the desktop's display scaling: the
// physical window grows with the scale factor, the CSS viewport stays put, and
// the render scale keeps matching the app scale.
for (const appScale of [design.minScale, design.defaultScale, design.maxScale]) {
  const logicalWidth = design.width * appScale * design.windowScaleBase;
  const logicalHeight = design.outerHeight * appScale * design.windowScaleBase;
  for (const systemScale of [1, 1.25, 4 / 3, 1.5, 2, 2.5]) {
    const physicalWidth = Math.round(logicalWidth * systemScale);
    const physicalHeight = Math.round(logicalHeight * systemScale);
    const cssWidth = physicalWidth / systemScale;
    const cssHeight = physicalHeight / systemScale;
    const renderScale = Math.min(cssWidth / design.width, cssHeight / design.outerHeight);
    const expectedRenderScale = appScale * design.windowScaleBase;
    if (Math.abs(renderScale - expectedRenderScale) > 0.002) {
      failures.push(
        `Render scale ${renderScale.toFixed(4)} != ${expectedRenderScale.toFixed(4)} ` +
          `for app=${appScale}, system=${systemScale}`,
      );
    }
    // What the content actually gets, once the titlebar has taken its strip,
    // must still be the full design height at every scale combination.
    const contentHeight = cssHeight / renderScale - design.titlebar;
    if (Math.abs(contentHeight - design.height) > 1) {
      failures.push(
        `Content height ${contentHeight.toFixed(1)} != ${design.height} ` +
          `for app=${appScale}, system=${systemScale}`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Window scaling configuration is inconsistent:\n${failures.join("\n")}`);
}

console.log("Window scaling follows display scaling consistently in root, Linux, and Windows configs.");
