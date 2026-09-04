import assert from "node:assert/strict";
import { R2Client } from "./r2.build.mjs";
import { startMockR2Worker } from "./mock-r2.mjs";

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactBuffer(value) {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const mock = await startMockR2Worker();
const client = new R2Client(
  mock.workerUrl,
  "owen-mobile",
  mock.token,
  "device-test-0001"
);

const health = await client.health();
assert.equal(health.historyProtocol, 1);
assert.equal(client.supportsHistory, true);
const root = await client.findFolder("ignored");
assert.equal(root, "owen-mobile");

const original = new TextEncoder().encode("# R2 sync\n").buffer;
const created = await client.upload("note.md", "", original, undefined, undefined, undefined, 1000);
assert.equal(created.path, "note.md");
assert.equal(created.size, String(original.byteLength));
assert.match(mock.objects.get("note.md").operationId, /^[0-9a-f-]{36}$/);

mock.resetIndexRequests();
mock.resetHistoryRequests();
let tree = await client.listTree(root);
assert.equal(mock.indexRequests, 1, "one Worker index request must describe the whole remote vault");
assert.equal(mock.historyRequests, 0, "normal index listing must not enumerate history");
assert.equal(tree.size, 1);
assert.equal(tree.get("note.md")?.id, created.id);

const downloaded = await client.download(created.id, created.revision, original.byteLength);
assert.deepEqual(new Uint8Array(downloaded), new Uint8Array(original));

const updatedBytes = new TextEncoder().encode("# R2 sync updated\n").buffer;
const updated = await client.upload(
  "note.md",
  "",
  updatedBytes,
  created.id,
  created.revision,
  undefined,
  2000
);
assert.notEqual(updated.revision, created.revision);
assert.match(mock.objects.get("note.md").operationId, /^[0-9a-f-]{36}$/);

await assert.rejects(
  () => client.upload("note.md", "", original, created.id, created.revision),
  /changed|precondition/i
);

const archiveGuard = await client.upload(
  "archive-guard.md",
  "",
  exactBuffer("must remain"),
  undefined,
  undefined,
  undefined,
  2500
);
mock.state.rejectHistoryArchive = true;
await assert.rejects(
  () => client.upload(
    "archive-guard.md",
    "",
    exactBuffer("must not commit"),
    archiveGuard.id,
    archiveGuard.revision,
    undefined,
    2600
  ),
  /history archive rejection/i
);
mock.state.rejectHistoryArchive = false;
assert.equal(new TextDecoder().decode(mock.objects.get("archive-guard.md").body), "must remain");

mock.failNextResponseAfterCommit();
const recoveredBytes = new TextEncoder().encode("response lost after commit\n").buffer;
const recovered = await client.upload(
  "recovered.md",
  "",
  recoveredBytes,
  undefined,
  undefined,
  undefined,
  3000
);
assert.equal(recovered.path, "recovered.md");
assert.equal([...mock.objects.values()].filter((entry) => entry.path === "recovered.md").length, 1);
assert.match(mock.objects.get("recovered.md").operationId, /^[0-9a-f-]{36}$/);

const historyOriginal = await client.upload(
  "history.md",
  "",
  exactBuffer("history original"),
  undefined,
  undefined,
  undefined,
  3100
);
const historyUpdated = await client.upload(
  "history.md",
  "",
  exactBuffer("history updated"),
  historyOriginal.id,
  historyOriginal.revision,
  undefined,
  3200
);
const historyPage = await client.listHistory(historyOriginal.id, 1);
assert.equal(historyPage.versions.length, 1);
assert.equal(historyPage.versions[0].path, "history.md");
assert.equal(historyPage.versions[0].sourceRevision, historyOriginal.revision);
assert.equal(historyPage.versions[0].deleted, false);
const historyHead = await client.headHistory(historyOriginal.id, historyPage.versions[0].versionId);
assert.deepEqual(historyHead, historyPage.versions[0]);
const historyBytes = await client.downloadHistory(historyOriginal.id, historyPage.versions[0].versionId);
assert.equal(new TextDecoder().decode(historyBytes), "history original");

mock.failNextResponseAfterCommit();
const restored = await client.restoreHistory(historyPage.versions[0], {
  id: historyOriginal.id,
  path: "history.md",
  revision: historyUpdated.revision,
}, 3300);
assert.notEqual(restored.revision, historyUpdated.revision);
assert.equal(new TextDecoder().decode(mock.objects.get("history.md").body), "history original");
assert.match(mock.objects.get("history.md").operationId, /^[0-9a-f-]{36}$/);
assert.equal(mock.history.get(historyOriginal.id).length, 2, "restore replay must not duplicate history");
const firstHistoryPage = await client.listHistory(historyOriginal.id, 1);
assert.ok(firstHistoryPage.nextCursor);
const secondHistoryPage = await client.listHistory(
  historyOriginal.id,
  1,
  firstHistoryPage.nextCursor
);
assert.notEqual(secondHistoryPage.versions[0].versionId, firstHistoryPage.versions[0].versionId);

let deleted = await client.upload(
  "deleted.md",
  "",
  exactBuffer("deleted original"),
  undefined,
  undefined,
  undefined,
  3400
);
deleted = await client.upload(
  "deleted.md",
  "",
  exactBuffer("deleted latest"),
  deleted.id,
  deleted.revision,
  undefined,
  3500
);
await client.trash(deleted.id, deleted.revision);
tree = await client.listTree(root);
assert.equal(tree.has("deleted.md"), false);
const deletedCurrent = client.deletedFiles().find((file) => file.id === deleted.id);
assert.ok(deletedCurrent?.deleted);
const deletedHistory = await client.listHistory(deleted.id, 50);
const latestLive = deletedHistory.versions.find((version) => !version.deleted);
assert.ok(latestLive);
await client.restoreHistory(latestLive, deletedCurrent, 3600);
tree = await client.listTree(root);
assert.equal(tree.get("deleted.md")?.id, deleted.id);
assert.equal(new TextDecoder().decode(await client.download(deleted.id)), "deleted latest");

const validHistory = mock.history.get(historyOriginal.id)[0];
mock.history.set("corrupt-history-id", [{
  ...validHistory,
  fileId: "corrupt-history-id",
  versionId: "corrupt-version",
  mtime: Number.NaN,
}]);
await assert.rejects(
  () => client.listHistory("corrupt-history-id", 50),
  /invalid history mtime|invalid history page/i
);

tree = await client.listTree(root);
const moved = await client.move(updated.id, "renamed.md", "", updated.revision);
assert.equal(moved.path, "renamed.md");
assert.match(mock.objects.get("renamed.md").operationId, /^[0-9a-f-]{36}$/);
tree = await client.listTree(root);
assert.equal(tree.has("note.md"), false);
assert.equal(tree.get("renamed.md")?.id, updated.id);

const recreated = await client.upload("note.md", "", exactBuffer("new file at old path"), undefined, undefined, undefined, 2500);
assert.notEqual(recreated.id, moved.id, "recreating a moved-from path must not duplicate the live stable ID");

await client.trash(moved.id, moved.revision);
tree = await client.listTree(root);
assert.equal(tree.has("renamed.md"), false);
assert.match(mock.objects.get("renamed.md").operationId, /^[0-9a-f-]{36}$/);

const image = new Uint8Array(12 * 1024 * 1024);
for (let index = 0; index < image.length; index++) image[index] = index % 251;
const imageBuffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);
const imageFile = await client.upload("photo.bin", "attachments", imageBuffer, undefined, undefined, undefined, 4000);
assert.match(mock.objects.get("attachments/photo.bin").operationId, /^[0-9a-f-]{36}$/);
const imageRoundTrip = await client.download(imageFile.id, imageFile.revision, image.byteLength);
assert.deepEqual(new Uint8Array(imageRoundTrip), image);

for (let index = 0; index < 500; index++) {
  const path = `bulk/${String(index).padStart(4, "0")}.md`;
  const body = new TextEncoder().encode(String(index));
  mock.objects.set(path, {
    path,
    fileId: `bulk-file-${String(index).padStart(4, "0")}`,
    hash: await hash(body),
    mtime: 5000 + index,
    deviceId: "device-bulk-0001",
    deleted: false,
    revision: `bulk-rev-${index}`,
    contentType: "text/markdown",
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
}
mock.resetIndexRequests();
const indexStartedAt = performance.now();
const bulkTree = await client.listTree(root);
const indexElapsedMs = performance.now() - indexStartedAt;
assert.equal(mock.indexRequests, 1, "500+ files must still use one client index request");
assert.ok(bulkTree.size >= 501);
assert.ok(indexElapsedMs < 2000, `local 500-file index took ${indexElapsedMs.toFixed(1)}ms`);

await mock.close();

const legacyMock = await startMockR2Worker();
legacyMock.state.historyProtocol = null;
const legacyClient = new R2Client(
  legacyMock.workerUrl,
  "owen-mobile",
  legacyMock.token,
  "device-legacy-0001"
);
assert.equal((await legacyClient.health()).historyProtocol, null);
assert.equal(legacyClient.supportsHistory, false);
const legacyFile = await legacyClient.upload("legacy.md", "", exactBuffer("normal sync still works"));
assert.equal((await legacyClient.listTree("owen-mobile")).get("legacy.md")?.id, legacyFile.id);
await legacyMock.close();

console.log(`r2 integration: CAS, immutable history, operation recovery, deleted restore, multipart, and 500-file single-index passed (${indexElapsedMs.toFixed(1)}ms)`);
