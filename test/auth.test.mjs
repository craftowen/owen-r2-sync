import { strict as assert } from "node:assert";
import { createPkce } from "./auth.build.mjs";

const first = await createPkce();
const second = await createPkce();
assert.notEqual(first.state, second.state);
assert.notEqual(first.codeVerifier, second.codeVerifier);
assert.match(first.state, /^[A-Za-z0-9_-]+$/);
assert.match(first.codeChallenge, /^[A-Za-z0-9_-]+$/);
assert.ok(first.codeVerifier.length >= 43 && first.codeVerifier.length <= 128);

console.log("auth: cryptographic state and PKCE material passed");
