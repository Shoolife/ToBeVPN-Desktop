let activeUpdateToken: number | null = null;
let nextUpdateToken = 0;

export function beginUpdateInstall(): number {
  nextUpdateToken += 1;
  activeUpdateToken = nextUpdateToken;
  return nextUpdateToken;
}

export function endUpdateInstall(token: number): void {
  if (activeUpdateToken === token) activeUpdateToken = null;
}

export function isUpdateInstallInProgress(): boolean {
  return activeUpdateToken !== null;
}
