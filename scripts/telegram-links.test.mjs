import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

// telegramLinks.ts has no imports; rolldown compiles it (TypeScript 7 has no
// compiler API to transpile with) and the module is loaded from memory.
const modulePath = fileURLToPath(new URL("../src/session/telegramLinks.ts", import.meta.url));
const bundle = await rolldown({ input: modulePath, logLevel: "silent" });
const code = (await bundle.generate({ format: "esm" })).output[0].code;
await bundle.close();
const { telegramDeepLink } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("a username opens its chat, with the parameters Telegram takes", () => {
  assert.equal(telegramDeepLink("https://t.me/meow_meow_vpn"), "tg://resolve?domain=meow_meow_vpn");
  assert.equal(telegramDeepLink("https://t.me/meow_meow_vpn?direct"), "tg://resolve?domain=meow_meow_vpn&direct");
  assert.equal(
    telegramDeepLink("https://t.me/meow_meow_vpn_bot?start=ref_123"),
    "tg://resolve?domain=meow_meow_vpn_bot&start=ref_123",
  );
  assert.equal(telegramDeepLink("http://telegram.me/SomeBot?startapp=x%20y"), "tg://resolve?domain=SomeBot&startapp=x%20y");
  // Parameters Telegram does not take are not passed on.
  assert.equal(telegramDeepLink("https://t.me/meow_meow_vpn?utm=1"), "tg://resolve?domain=meow_meow_vpn");
});

test("posts, Mini Apps, invites, shares and private posts", () => {
  assert.equal(telegramDeepLink("https://t.me/meow_meow_vpn/42"), "tg://resolve?domain=meow_meow_vpn&post=42");
  assert.equal(telegramDeepLink("https://t.me/SomeBot/shop?startapp=a"), "tg://resolve?domain=SomeBot&appname=shop&startapp=a");
  assert.equal(telegramDeepLink("https://t.me/+AbCdEf123456"), "tg://join?invite=AbCdEf123456");
  assert.equal(telegramDeepLink("https://t.me/joinchat/AbCdEf123456"), "tg://join?invite=AbCdEf123456");
  assert.equal(
    telegramDeepLink("https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fbot%3Fstart%3Dref&text=Hi%20there"),
    "tg://msg_url?url=https%3A%2F%2Ft.me%2Fbot%3Fstart%3Dref&text=Hi%20there",
  );
  assert.equal(telegramDeepLink("https://t.me/c/1234567/89"), "tg://privatepost?channel=1234567&post=89");
  assert.equal(telegramDeepLink("https://t.me/s/meow_meow_vpn"), "tg://resolve?domain=meow_meow_vpn");
});

test("anything else stays a web link", () => {
  for (const link of [
    "https://example.com/meow_meow_vpn",
    "https://t.me/",
    "https://t.me/iv?url=https://example.com",
    "https://t.me/proxy?server=1.2.3.4",
    "https://t.me/a/b/c",
    "https://user@t.me/meow_meow_vpn",
    "https://t.me:8443/meow_meow_vpn",
    "https://t.me/share/url",
    "tg://resolve?domain=x",
    "not a url",
  ]) {
    assert.equal(telegramDeepLink(link), null, link);
  }
});
