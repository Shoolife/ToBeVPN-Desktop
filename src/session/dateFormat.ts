export function formatDateDots(epochMillis: number): string {
  const date = new Date(epochMillis);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

export function formatEpochSecondsDateDots(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "";
  return formatDateDots(epochSeconds * 1000);
}
