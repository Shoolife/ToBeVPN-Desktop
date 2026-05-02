const GLOBE_FLAG = "\u{1F310}";
const REGIONAL_INDICATOR_START = 0x1f1e6;
const REGIONAL_INDICATOR_END = 0x1f1ff;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;
const DECORATIVE = /[\p{S}\p{M}\p{Cf}]/u;

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

export function serverCountryCodeForUi(
  countryCode: string | null | undefined,
  serverName: string,
): string {
  const normalizedCode = countryCode?.trim().toUpperCase() ?? "";
  if (countryFlagOrNull(normalizedCode)) return normalizedCode;
  return countryCodeFromFlag(parseLeadingPrefix(serverName).flag) ?? "";
}

export function serverDisplayName(
  name: string,
  countryCode: string | null | undefined,
): string {
  const trimmedName = name.trim();
  if (!trimmedName) return name;

  const prefix = parseLeadingPrefix(trimmedName);
  const countryFlag = countryFlagOrNull(countryCode?.trim().toUpperCase() ?? "");
  if (countryFlag && prefix.flag && prefix.flag !== countryFlag) {
    return trimmedName;
  }

  const cleanedName = trimmedName.slice(prefix.endIndex).trimStart();
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

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= REGIONAL_INDICATOR_START && codePoint <= REGIONAL_INDICATOR_END;
}

function isDecorativeCodePoint(codePoint: number): boolean {
  return DECORATIVE.test(String.fromCodePoint(codePoint));
}
