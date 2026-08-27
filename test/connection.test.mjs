import { strict as assert } from "node:assert";
import {
  decryptConnectionPayload,
  encryptConnectionPayload,
  importedTokens,
} from "./connection.build.mjs";

const now = 1_800_000_000_000;
const secret = "refresh-token-that-must-not-be-visible";
const passphrase = "correct horse battery staple";
const code = await encryptConnectionPayload(
  {
    clientId: "mock-client-id",
    clientSecret: "desktop-secret",
    refreshToken: secret,
    rootFolderId: "folder-id",
    driveFolderName: "owen-mobile",
  },
  passphrase,
  now
);
assert.equal(code.includes(secret), false, "encrypted code must not reveal the refresh token");
const payload = await decryptConnectionPayload(code, passphrase, now + 1_000);
assert.equal(payload.refreshToken, secret);
assert.deepEqual(importedTokens(payload), {
  accessToken: "",
  refreshToken: secret,
  expiresAt: 0,
});
await assert.rejects(() => decryptConnectionPayload(code, "wrong password long enough", now));
await assert.rejects(
  () => decryptConnectionPayload(code, passphrase, now + 16 * 60 * 1_000),
  /expired/
);

console.log("connection: encrypted, expiring, refresh-only device transfer passed");
