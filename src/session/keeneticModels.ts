// Keenetic models whole-home VPN is being prepared for, as on the phone: the
// routers that run Xray from Entware, after XKeen's list
// (github.com/jameszeroX/XKeen, wiki Routers-Info). Netcraze is Keenetic's
// Russian name: NC-1012 is KN-1012. The model is the number on the router's
// label ("Модель KN-1610"); the name the router reports is not enough, since
// one name ("Extra") covers models in and out of the list, and the owner can
// rename the router.

import { invoke } from "@tauri-apps/api/core";

export type KeeneticArch = "aarch64" | "mipsel" | "mips";

const SUPPORTED = new Map<string, KeeneticArch>([
  ...["4210", "2710", "1811", "1812", "1012", "1013", "3811", "3812", "2312", "4110"]
    .map((n) => [n, "aarch64"] as const),
  ...[
    "1010", "1011", "1810", "1910", "1912", "1913", "2610", "2310", "2311",
    "3810", "2910", "2012", "2113", "3611", "1212", "1711", "1713",
  ].map((n) => [n, "mipsel"] as const),
  ...["2510", "2410", "2010", "2112", "2110", "3610"].map((n) => [n, "mips"] as const),
]);

const MODEL = /^(?:(?:KN|NC)\s*-?\s*)?(\d{4})$/;

/**
 * The model number from what the owner typed: "KN-1610", "nc 1012", "1810"
 * all give the four digits; null when it is not a Keenetic or Netcraze model.
 */
export function parseKeeneticModel(input: string): string | null {
  const match = MODEL.exec(input.trim().toUpperCase());
  return match ? match[1] : null;
}

/**
 * The model as the owner wrote it on screen: "NC-1012" for a Netcraze label,
 * "KN-1012" otherwise; null when it is not a model number.
 */
export function keeneticModelLabel(input: string): string | null {
  const number = parseKeeneticModel(input);
  if (!number) return null;
  return `${input.trim().toUpperCase().startsWith("NC") ? "NC" : "KN"}-${number}`;
}

/** The list's processor family for a model number, or null when the model is not in the list. */
export function keeneticArch(number: string): KeeneticArch | null {
  return SUPPORTED.get(number) ?? null;
}

/** Why reading the model from the router failed (codes from the native side). */
export type KeeneticDetectError =
  | "no_router"
  | "unreachable"
  | "not_keenetic"
  | "wrong_password"
  | "no_model";

/**
 * The model number of the Keenetic/Netcraze in this network ("KN-1011"),
 * read by logging in to it with the owner's web interface login and password.
 * The password goes to the router only, once, and is not kept.
 */
export async function detectKeeneticModel(
  login: string,
  password: string,
): Promise<{ hwId: string; description: string | null }> {
  try {
    const version = await invoke<{ hwId: string; description: string | null }>(
      "keenetic_model",
      { login, password },
    );
    return { hwId: version.hwId, description: version.description ?? null };
  } catch (error) {
    const code = String(error);
    const known: KeeneticDetectError[] = ["no_router", "unreachable", "not_keenetic", "wrong_password", "no_model"];
    throw known.includes(code as KeeneticDetectError) ? code : "unreachable";
  }
}
