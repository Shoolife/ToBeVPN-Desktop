/**
 * Telegram web links (t.me) as Telegram's own deep links (tg://), so a link
 * opens straight in the Telegram app instead of a browser page that then
 * asks to open Telegram. Only the link shapes Telegram documents are mapped,
 * and only the parameters they take are carried over; anything else stays a
 * web link (null here) and opens in the browser as before.
 */

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog", "www.t.me", "www.telegram.me"]);

/** A public username: a letter first, then letters, digits and "_". */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;
const INVITE = /^[A-Za-z0-9_-]{8,128}$/;
const NUMBER = /^\d{1,20}$/;

/** First path parts that are t.me pages, not usernames. */
const RESERVED = new Set([
  "addemoji", "addlist", "addstickers", "addtheme", "auth", "bg", "boost", "c", "confirmphone",
  "contact", "giftcode", "invoice", "iv", "joinchat", "login", "m", "proxy", "s", "setlanguage",
  "share", "socks", "msg", "msg_url",
]);

/** Parameters of a username link that Telegram's resolve link takes. */
const RESOLVE_PARAMS = ["start", "startapp", "startgroup", "startchannel", "admin", "text", "comment", "thread", "single"];
/** Parameters Telegram takes with no value ("?direct"). */
const FLAG_PARAMS = new Set(["single"]);

function query(pairs: Array<[string, string | null]>): string {
  return pairs
    .map(([key, value]) => (value === null ? key : `${key}=${encodeURIComponent(value)}`))
    .join("&");
}

/** The tg:// deep link for a Telegram web link, or null when it is not one. */
export function telegramDeepLink(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !TELEGRAM_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  const params = url.searchParams;
  const [first, second, third] = parts;
  if (!first) return null;

  // t.me/+HASH and t.me/joinchat/HASH: an invite link.
  if (parts.length === 1 && first.startsWith("+") && INVITE.test(first.slice(1))) {
    return `tg://join?${query([["invite", first.slice(1)]])}`;
  }
  if (first === "joinchat" && parts.length === 2 && INVITE.test(second)) {
    return `tg://join?${query([["invite", second]])}`;
  }
  // t.me/share/url?url=…&text=…: the share sheet.
  if (first === "share" && (parts.length === 1 || (parts.length === 2 && second === "url"))) {
    const shared = params.get("url");
    if (!shared) return null;
    const pairs: Array<[string, string | null]> = [["url", shared]];
    const text = params.get("text");
    if (text) pairs.push(["text", text]);
    return `tg://msg_url?${query(pairs)}`;
  }
  // t.me/c/CHANNEL/POST: a post of a private channel.
  if (first === "c" && parts.length === 3 && NUMBER.test(second) && NUMBER.test(third)) {
    return `tg://privatepost?${query([["channel", second], ["post", third]])}`;
  }
  // t.me/s/USERNAME: the web preview of a channel; the channel itself.
  if (first === "s" && parts.length === 2 && USERNAME.test(second)) {
    return `tg://resolve?${query([["domain", second]])}`;
  }
  if (RESERVED.has(first.toLowerCase()) || !USERNAME.test(first) || parts.length > 2) return null;

  const pairs: Array<[string, string | null]> = [["domain", first]];
  if (parts.length === 2) {
    // t.me/USERNAME/123 is a post; t.me/USERNAME/app a bot's named Mini App.
    if (NUMBER.test(second)) pairs.push(["post", second]);
    else if (USERNAME.test(second)) pairs.push(["appname", second]);
    else return null;
  }
  for (const key of RESOLVE_PARAMS) {
    if (!params.has(key)) continue;
    const parameter = params.get(key) ?? "";
    if (FLAG_PARAMS.has(key) && parameter === "") pairs.push([key, null]);
    else if (parameter !== "") pairs.push([key, parameter]);
  }
  if (params.has("direct")) pairs.push(["direct", null]);
  return `tg://resolve?${query(pairs)}`;
}
