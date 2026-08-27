// The real DriveClient run against the mock Drive server: token refresh,
// folder creation, upload, listing, download, rename/move, trash, and the
// retry-on-500 path. What passes here is the same code Obsidian executes.
import { strict as assert } from "node:assert";
import { startMockDrive } from "./mock-drive.mjs";
import { DriveClient } from "./drive.build.mjs";

const enc = (s) => new TextEncoder().encode(s).buffer;
const dec = (b) => new TextDecoder().decode(b);

const mock = await startMockDrive();
let refreshed = 0;

const client = new DriveClient(
  "client-id",
  "client-secret",
  { accessToken: "stale", refreshToken: "r", expiresAt: 0 }, // expired: forces a refresh
  () => refreshed++,
  mock.endpoints
);

// Preview lookup is read-only: a missing root is not created until approval.
const filesBeforePreview = mock.files.size;
assert.equal(await client.findFolder("Preview only"), null);
assert.equal(mock.files.size, filesBeforePreview);

// Folder creation is idempotent.
const rootId = await client.ensureFolder("Vault");
assert.equal(await client.ensureFolder("Vault"), rootId);
await client.verifyFolder(rootId);
assert.ok(refreshed >= 1, "expired token was refreshed through the mock");

// A create committed by Drive with a lost 500 response is reconciled by
// parent/name and never creates a duplicate sibling.
mock.state.commitThenFailFolder = true;
const recoveredFolder = await client.ensureFolder("Recovered folder", rootId);
assert.ok(recoveredFolder);
assert.equal(
  [...mock.files.values()].filter((file) => file.name === "Recovered folder").length,
  1
);

// Upload, list, download round trip.
const up = await client.upload("a.md", rootId, enc("hello world"));
assert.ok(up.md5Checksum);
let tree = await client.listTree(rootId);
assert.deepEqual([...tree.keys()], ["a.md"]);
assert.equal(dec(await client.download(up.id)), "hello world");

mock.state.commitThenFailUpload = true;
const recoveredUpload = await client.upload("ambiguous.md", rootId, enc("one copy"));
assert.equal(dec(await client.download(recoveredUpload.id)), "one copy");
assert.equal(
  [...mock.files.values()].filter((file) => file.name === "ambiguous.md").length,
  1
);
await client.trash(recoveredUpload.id);

// Update in place keeps the id, changes the checksum.
const up2 = await client.upload("a.md", rootId, enc("hello again"), up.id);
assert.equal(up2.id, up.id);
assert.notEqual(up2.md5Checksum, up.md5Checksum);

// Nested folders and a move (rename into a subfolder).
const subId = await client.ensurePath(rootId, ["notes", "daily"], new Map());
await client.move(up.id, "b.md", subId);
tree = await client.listTree(rootId);
assert.deepEqual([...tree.keys()], ["notes/daily/b.md"]);

// Trash hides the file from listings.
await client.trash(up.id);
tree = await client.listTree(rootId);
assert.equal(tree.size, 0);

// Transient 500s are retried instead of failing the sync.
const up3 = await client.upload("c.md", rootId, enc("survivor"));
mock.state.failNext = 2;
mock.state.failStatus = 500;
assert.equal(dec(await client.download(up3.id)), "survivor");
assert.equal(mock.state.failNext, 0, "retries consumed the injected failures");

// A stable-ID update refuses to overwrite a newer remote revision than the
// one included in the approved plan.
await client.upload("c.md", rootId, enc("newer remote"), up3.id);
await assert.rejects(
  () => client.upload("c.md", rootId, enc("stale overwrite"), up3.id, up3.md5Checksum),
  /changed after planning/
);
assert.equal(dec(await client.download(up3.id)), "newer remote");

// Permanent permission errors are not retried blindly.
const requestsBefore403 = mock.state.requests;
mock.state.failNext = 1;
mock.state.failStatus = 403;
mock.state.failReason = "insufficientFilePermissions";
await assert.rejects(() => client.download(up3.id), /Drive returned 403/);
assert.equal(mock.state.requests, requestsBefore403 + 1);

await DriveClient.revokeToken("mock-refresh", mock.endpoints.revoke);
assert.equal(mock.state.revoked, true);

mock.close();
console.log("drive integration: idempotency, retry, and file-ID assertions passed");
