import { strict as assert } from "node:assert";
import { createPkce, startLoopbackAuth } from "./auth.build.mjs";

const first = await createPkce();
const second = await createPkce();
assert.notEqual(first.state, second.state);
assert.notEqual(first.codeVerifier, second.codeVerifier);
assert.match(first.state, /^[A-Za-z0-9_-]+$/);
assert.match(first.codeChallenge, /^[A-Za-z0-9_-]+$/);
assert.ok(first.codeVerifier.length >= 43 && first.codeVerifier.length <= 128);

async function harness() {
  let handler;
  let authUrl = "";
  let closed = false;
  const server = {
    address: () => ({ port: 43123 }),
    close: () => { closed = true; },
    listen: (_port, _host, ready) => ready(),
    on: () => undefined,
  };
  const promise = startLoopbackAuth(
    "client-id",
    (url) => { authUrl = url; },
    {
      createServer(callback) {
        handler = callback;
        return server;
      },
    }
  );
  for (let attempt = 0; attempt < 20 && !handler; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(handler, "loopback request handler was installed");
  assert.ok(authUrl, "authorization URL was emitted");
  const respond = (url) => {
    const result = { status: 0, headers: {}, body: "" };
    handler(
      { url },
      {
        writeHead(status, headers) {
          result.status = status;
          result.headers = headers;
        },
        end(body) { result.body = body; },
      }
    );
    return result;
  };
  return { promise, authUrl, respond, isClosed: () => closed };
}

const valid = await harness();
const state = new URL(valid.authUrl).searchParams.get("state");
assert.equal(valid.respond("/health").status, 204);
const okResponse = valid.respond(`/callback?code=accepted&state=${state}`);
assert.equal(okResponse.status, 200);
const auth = await valid.promise;
assert.equal(auth.code, "accepted");
assert.equal(auth.redirectUri, "http://127.0.0.1:43123/callback");
assert.ok(auth.codeVerifier.length >= 43);
assert.equal(valid.isClosed(), true);
assert.equal(valid.respond(`/callback?code=replayed&state=${state}`).status, 409);

const invalid = await harness();
assert.equal(invalid.respond("/callback?code=injected&state=wrong").status, 400);
await assert.rejects(invalid.promise, /state did not match/);

console.log("auth: PKCE and loopback callback state/path/replay checks passed");
