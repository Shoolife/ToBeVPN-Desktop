const GLOBE_FLAG = "\u{1F310}";
const COUNTRY_FLAGS_FONT = '16px "Twemoji Country Flags"';
const COUNTRY_FLAGS_TEST_TEXT = "\u{1F1F3}\u{1F1F1}";
const REGIONAL_INDICATOR_START = 0x1f1e6;
const REGIONAL_INDICATOR_END = 0x1f1ff;
const EDGE_DECORATION = new Set(["-", "|", "/", "\\", ":"]);
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;
const DECORATIVE = /[\p{S}\p{M}\p{Cf}]/u;

let countryFlagsReady = false;
let countryFlagsReadyPromise: Promise<boolean> | null = null;

interface PrefixInfo {
  endIndex: number;
  flag: string | null;
}

export function countryFlagForUi(
  countryCode: string | null | undefined,
  serverName: string,
): string {
  const displayCountryCode = serverCountryCodeForUi(countryCode, serverName);
  return (
    countryFlagOrNull(displayCountryCode) ??
    parseLeadingPrefix(serverName).flag ??
    GLOBE_FLAG
  );
}

export function areCountryFlagsReady(): boolean {
  if (countryFlagsReady) return true;
  if (typeof document === "undefined" || !document.fonts) {
    countryFlagsReady = true;
    return true;
  }
  if (document.fonts.check(COUNTRY_FLAGS_FONT, COUNTRY_FLAGS_TEST_TEXT)) {
    countryFlagsReady = true;
    return true;
  }
  return false;
}

export function ensureCountryFlagsReady(): Promise<boolean> {
  if (areCountryFlagsReady()) return Promise.resolve(true);
  if (typeof document === "undefined" || !document.fonts) {
    countryFlagsReady = true;
    return Promise.resolve(true);
  }

  countryFlagsReadyPromise ??= document.fonts
    .load(COUNTRY_FLAGS_FONT, COUNTRY_FLAGS_TEST_TEXT)
    .then(() => {
      countryFlagsReady = true;
      return true;
    })
    .catch(() => {
      countryFlagsReady = true;
      return true;
    });
  return countryFlagsReadyPromise;
}

void ensureCountryFlagsReady();

export function serverCountryCodeForUi(
  countryCode: string | null | undefined,
  serverName: string,
): string {
  // Server names like "Нидерланды 5" or "Швеция 1" are explicit user-facing
  // labels. They take priority over the panel's `country_code`, which can
  // point at the *entry* node of a cascade (e.g. RU→NL keeps country_code=RU
  // while the user sees and expects "Нидерланды").
  const codeFromName = countryCodeFromServerName(serverName);
  if (codeFromName) return codeFromName;

  const normalizedCode = countryCode?.trim().toUpperCase() ?? "";
  if (countryFlagOrNull(normalizedCode)) return normalizedCode;
  return countryCodeFromFlag(parseLeadingPrefix(serverName).flag) ?? "";
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "нидерланды": "NL",
  "netherlands": "NL",
  "швеция": "SE",
  "sweden": "SE",
  "финляндия": "FI",
  "finland": "FI",
  "германия": "DE",
  "germany": "DE",
  "франция": "FR",
  "france": "FR",
  "великобритания": "GB",
  "англия": "GB",
  "uk": "GB",
  "россия": "RU",
  "russia": "RU",
  "рф": "RU",
  "сша": "US",
  "usa": "US",
  "польша": "PL",
  "poland": "PL",
  "литва": "LT",
  "lithuania": "LT",
  "латвия": "LV",
  "latvia": "LV",
  "эстония": "EE",
  "estonia": "EE",
  "испания": "ES",
  "spain": "ES",
  "италия": "IT",
  "italy": "IT",
  "турция": "TR",
  "turkey": "TR",
  "япония": "JP",
  "japan": "JP",
  "сингапур": "SG",
  "singapore": "SG",
  "украина": "UA",
  "ukraine": "UA",
  "казахстан": "KZ",
  "kazakhstan": "KZ",
  "беларусь": "BY",
  "belarus": "BY",
};

const COUNTRY_NAME_TOKEN_SPLIT = /[^\p{L}]+/u;

function countryCodeFromServerName(serverName: string): string | null {
  // Match complete words. Substring matching classified "Ukraine" and
  // "Baku" as UK because the shorter "uk" key was encountered first.
  for (const token of serverName.toLowerCase().split(COUNTRY_NAME_TOKEN_SPLIT)) {
    const code = COUNTRY_NAME_TO_CODE[token];
    if (code) return code;
  }
  return null;
}

export function serverDisplayName(
  name: string,
  _countryCode: string | null | undefined,
): string {
  const trimmedName = name.trim();
  if (!trimmedName) return name;

  const prefix = parseLeadingPrefix(trimmedName);
  const cleanedName = trimDecorativeEdges(
    removeFlagEmojis(trimmedName.slice(prefix.endIndex)),
  );
  return cleanedName || trimmedName;
}

function countryFlagOrNull(countryCode: string): string | null {
  if (countryCode.length !== 2) return null;

  const firstChar = countryCode[0];
  const secondChar = countryCode[1];
  if (!firstChar || !secondChar) return null;
  if (!/[A-Z]/.test(firstChar) || !/[A-Z]/.test(secondChar)) return null;

  const first = REGIONAL_INDICATOR_START - 65 + firstChar.charCodeAt(0);
  const second = REGIONAL_INDICATOR_START - 65 + secondChar.charCodeAt(0);
  return String.fromCodePoint(first, second);
}

function parseLeadingPrefix(text: string): PrefixInfo {
  const trimmedText = text.trimStart();
  if (!trimmedText) return { endIndex: 0, flag: null };

  let index = 0;
  let flag: string | null = null;

  while (index < trimmedText.length) {
    const codePoint = trimmedText.codePointAt(index);
    if (codePoint === undefined) break;

    const symbol = String.fromCodePoint(codePoint);
    if (LETTER_OR_NUMBER.test(symbol)) break;

    if (isRegionalIndicator(codePoint)) {
      const nextIndex = index + symbol.length;
      if (nextIndex < trimmedText.length) {
        const nextCodePoint = trimmedText.codePointAt(nextIndex);
        if (
          nextCodePoint !== undefined &&
          isRegionalIndicator(nextCodePoint)
        ) {
          if (!flag) {
            flag = String.fromCodePoint(codePoint, nextCodePoint);
          }
          index =
            nextIndex + String.fromCodePoint(nextCodePoint).length;
          continue;
        }
      }
    }

    if (!WHITESPACE.test(symbol) && !isDecorativeCodePoint(codePoint)) {
      break;
    }
    index += symbol.length;
  }

  return { endIndex: index, flag };
}

function countryCodeFromFlag(flag: string | null): string | null {
  if (!flag) return null;

  const chars = Array.from(flag);
  if (chars.length < 2) return null;

  const first = chars[0].codePointAt(0);
  const second = chars[1].codePointAt(0);
  if (first === undefined || second === undefined) return null;
  if (!isRegionalIndicator(first) || !isRegionalIndicator(second)) return null;

  const firstChar = String.fromCharCode(first - REGIONAL_INDICATOR_START + 65);
  const secondChar = String.fromCharCode(
    second - REGIONAL_INDICATOR_START + 65,
  );
  return `${firstChar}${secondChar}`;
}

function removeFlagEmojis(text: string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;

    const symbol = String.fromCodePoint(codePoint);
    const nextIndex = index + symbol.length;
    if (isRegionalIndicator(codePoint) && nextIndex < text.length) {
      const nextCodePoint = text.codePointAt(nextIndex);
      if (
        nextCodePoint !== undefined &&
        isRegionalIndicator(nextCodePoint)
      ) {
        index = nextIndex + String.fromCodePoint(nextCodePoint).length;
        continue;
      }
    }

    output += symbol;
    index = nextIndex;
  }

  return output;
}

function trimDecorativeEdges(text: string): string {
  const trimmedText = text.trim();
  let start = 0;
  let end = trimmedText.length;

  while (start < end && EDGE_DECORATION.has(trimmedText[start])) {
    start += 1;
  }
  while (end > start && EDGE_DECORATION.has(trimmedText[end - 1])) {
    end -= 1;
  }

  return trimmedText.slice(start, end).trim();
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= REGIONAL_INDICATOR_START && codePoint <= REGIONAL_INDICATOR_END;
}

function isDecorativeCodePoint(codePoint: number): boolean {
  return DECORATIVE.test(String.fromCodePoint(codePoint));
}
