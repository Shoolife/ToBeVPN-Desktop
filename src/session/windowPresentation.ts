// At launch the native window is already shown but its contents stay
// transparent (index.html sets data-presenting on desktop frames) until App
// has given the window its startup size. Then the contents appear at once, in
// the final shape. The splash waits for that moment so its animation and hold
// time are actually seen.

let resolvePresented: () => void = () => {};

export const mainWindowPresented = new Promise<void>((resolve) => {
  resolvePresented = resolve;
});

export function markMainWindowPresented(): void {
  delete document.documentElement.dataset.presenting;
  resolvePresented();
}

// Safety net: never keep the window empty or hold the splash forever.
window.setTimeout(markMainWindowPresented, 4_000);
