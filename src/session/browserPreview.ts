export function isBrowserPreviewRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    import.meta.env.DEV &&
    !("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}
