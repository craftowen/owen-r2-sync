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

// Files larger than 5 MiB use bounded, chunked resumable upload. An ambiguous
// chunk response is reconciled through the session status without duplicates.
const large = new Uint8Array(6 * 1024 * 1024 + 17);
for (let index = 0; index < large.length; index++) large[index] = index % 251;
mock.state.failResumableChunkAfterCommit = true;
const largeUpload = await client.upload("large.bin", rootId, large.buffer);
assert.ok(mock.state.resumableChunks >= 2);
assert.deepEqual(new Uint8Array(await client.download(largeUpload.id)), large);
assert.equal(
  [...mock.files.values()].filter((file) => file.name === "large.bin").length,
  1
);
const changedLarge = large.slice();
changedLarge[changedLarge.length - 1] = 7;
const largeUpdate = await client.upload(
  "large.bin",
  rootId,
  changedLarge.buffer,
  largeUpload.id,
  largeUpload.md5Checksum
);
assert.equal(largeUpdate.id, largeUpload.id);
assert.deepEqual(new Uint8Array(await client.download(largeUpload.id)), changedLarge);
await client.trash(largeUpload.id);

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

// File IDs are encoded consistently across metadata, content, update, move,
// and trash URLs instead of being interpolated as path/query syntax.
mock.files.set("id with space", {
  id: "id with space",
  name: "encoded-id.md",
  mimeType: "application/octet-stream",
  parents: [rootId],
  content: Buffer.from("before"),
  trashed: false,
  modifiedTime: new Date().toISOString(),
});
const encodedMeta = await client.metadata("id with space");
await client.upload(
  "encoded-id.md",
  rootId,
  enc("after"),
  "id with space",
  encodedMeta.md5Checksum
);
assert.equal(dec(await client.download("id with space")), "after");
await client.trash("id with space");

// A Drive item name containing a path separator is rejected before it can be
// confused with an actual nested vault path.
mock.files.set("unsafe-name", {
  id: "unsafe-name",
  name: "nested/name.md",
  mimeType: "application/octet-stream",
  parents: [rootId],
  content: Buffer.from("unsafe"),
  trashed: false,
  modifiedTime: new Date().toISOString(),
});
await assert.rejects(() => client.listTree(rootId), /Unsafe Drive item name/);
mock.files.delete("unsafe-name");

await DriveClient.revokeToken("mock-refresh", mock.endpoints.revoke);
assert.equal(mock.state.revoked, true);

mock.close();
console.log("drive integration: multipart/resumable idempotency and file-ID assertions passed");
