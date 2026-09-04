import { strict as assert } from "node:assert";
import {
  decryptConnectionPayload,
  encryptConnectionPayload,
  presentConnectionCode,
} from "./connection.build.mjs";

const now = 1_800_000_000_000;
const secret = "r2-token-that-must-not-be-visible-123456";
const passphrase = "correct horse battery staple";
const code = await encryptConnectionPayload(
  {
    workerUrl: "https://sync.example.com",
    apiToken: secret,
    vaultId: "owen-mobile",
  },
  passphrase,
  now
);
assert.equal(code.includes(secret), false, "encrypted code must not reveal the refresh token");
const payload = await decryptConnectionPayload(code, passphrase, now + 1_000);
assert.equal(payload.apiToken, secret);
assert.equal(payload.workerUrl, "https://sync.example.com");
assert.equal(payload.vaultId, "owen-mobile");
await assert.rejects(() => decryptConnectionPayload(code, "wrong password long enough", now));
await assert.rejects(
  () => decryptConnectionPayload(code, passphrase, now + 16 * 60 * 1_000),
  /expired/
);

let displayed = "";
assert.equal(
  await presentConnectionCode("code-that-must-remain-visible", (value) => {
    displayed = value;
  }),
  false
);
assert.equal(displayed, "code-that-must-remain-visible");
let copied = "";
assert.equal(
  await presentConnectionCode(
    "copy-me",
    (value) => { displayed = value; },
    async (value) => { copied = value; }
  ),
  true
);
assert.equal(displayed, "copy-me");
assert.equal(copied, "copy-me");

console.log("connection: encrypted transfer and clipboard-fallback display passed");
