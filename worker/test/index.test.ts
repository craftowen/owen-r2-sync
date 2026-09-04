import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const TOKEN = "test-sync-token-with-at-least-32-bytes";
const VAULT = "owen-mobile";
const DEVICE = "device-0001";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function url(route: string, path?: string): string {
  const target = new URL(`https://worker.test/v1/${route}`);
  target.searchParams.set("vault", VAULT);
  if (path) target.searchParams.set("path", path);
  return target.toString();
}

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({ authorization: `Bearer ${TOKEN}`, ...extra });
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestText(value: string): Promise<string> {
  return digest(new TextEncoder().encode(value));
}

interface HistoryVersion {
  versionId: string;
  fileId: string;
  path: string;
  sha256: string;
  size: number;
  mtime: number;
  deviceId: string;
  deleted: boolean;
  sourceRevision: string;
  sourceVersion: string;
  sourceUploadedAt: string;
  archivedAt: string;
  contentType: string;
}

async function listHistory(
  fileId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ versions: HistoryVersion[]; nextCursor: string | null }> {
  const target = new URL(url("history"));
  target.searchParams.set("fileId", fileId);
  if (options.limit !== undefined) target.searchParams.set("limit", String(options.limit));
  if (options.cursor !== undefined) target.searchParams.set("cursor", options.cursor);
  const response = await SELF.fetch(target, { headers: headers() });
  expect(response.status).toBe(200);
  return response.json<{ versions: HistoryVersion[]; nextCursor: string | null }>();
}

async function downloadHistory(fileId: string, versionId: string): Promise<Response> {
  const target = new URL(url("history/file"));
  target.searchParams.set("fileId", fileId);
  target.searchParams.set("versionId", versionId);
  return SELF.fetch(target, { headers: headers() });
}

async function expectedHistoryIdentity(path: string): Promise<{
  source: R2Object;
  versionId: string;
  key: string;
}> {
  const canonicalKey = `vaults/${VAULT}/files/${encodeURIComponent(path)}`;
  const source = await env.VAULT.head(canonicalKey);
  if (!source) throw new Error(`missing canonical test source: ${path}`);
  const metadata = source.customMetadata ?? {};
  const sourceUploadedAt = source.uploaded.toISOString();
  const reverseTimestamp = String(9_999_999_999_999 - source.uploaded.getTime()).padStart(13, "0");
  const content = JSON.stringify([
    metadata.fileId,
    metadata.path,
    source.version,
    source.etag,
    sourceUploadedAt,
    metadata.contentHash,
    Number(metadata.contentSize),
    Number(metadata.clientMtime),
    metadata.deviceId,
    metadata.deleted === "1",
    metadata.operationId ?? null,
    metadata.lastRestoreId ?? null,
  ]);
  const versionId = `${reverseTimestamp}-${await digestText(content)}`;
  return {
    source,
    versionId,
    key: `vaults/${VAULT}/history/${metadata.fileId}/${versionId}`,
  };
}

async function put(
  path: string,
  body: Uint8Array,
  fileId: string,
  condition: Record<string, string> = { "if-none-match": "*" },
): Promise<Response> {
  return SELF.fetch(url("file", path), {
    method: "PUT",
    headers: headers({
      ...condition,
      "content-type": path.endsWith(".md") ? "text/markdown" : "application/octet-stream",
      "x-owen-file-id": fileId,
      "x-owen-sha256": await digest(body),
      "x-owen-mtime": "1234",
      "x-owen-size": String(body.byteLength),
      "x-owen-device-id": DEVICE,
    }),
    body,
  });
}

async function snapshotVaultObjects(): Promise<Array<{
  key: string;
  etag: string;
  version: string;
  size: number;
}>> {
  const snapshot: Array<{ key: string; etag: string; version: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const listed = await env.VAULT.list({
      prefix: `vaults/${VAULT}/`,
      cursor,
      limit: 1000,
    });
    snapshot.push(...listed.objects.map((object) => ({
      key: object.key,
      etag: object.etag,
      version: object.version,
      size: object.size,
    })));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return snapshot;
}

beforeEach(async () => {
  let cursor: string | undefined;
  do {
    const listed = await env.VAULT.list({ prefix: `vaults/${VAULT}/`, cursor });
    if (listed.objects.length > 0) await env.VAULT.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
});

describe("authentication and validation", () => {
  it("rejects missing credentials", async () => {
    const response = await SELF.fetch(url("health"));
    expect(response.status).toBe(401);
  });

  it("rejects unsafe paths", async () => {
    const response = await SELF.fetch(url("file", "../secret.md"), {
      method: "GET",
      headers: headers(),
    });
    expect(response.status).toBe(400);
  });

  it("advertises history capability only after authentication", async () => {
    const response = await SELF.fetch(url("health"), { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ historyProtocol: 1 }));
  });
});

describe("R2 file protocol", () => {
  it("creates, lists, conditionally reads, and updates a Markdown file", async () => {
    const first = new TextEncoder().encode("# 첫 노트\n");
    const created = await put("30-wiki/첫-노트.md", first, "file-0001");
    expect(created.status).toBe(200);
    const createdMeta = await created.json<{ revision: string }>();

    const index = await SELF.fetch(url("index"), { headers: headers() });
    expect(index.status).toBe(200);
    const body = await index.json<{ entries: Array<{ path: string; fileId: string; revision: string; deleted: boolean }> }>();
    expect(body.entries).toEqual([
      expect.objectContaining({
        path: "30-wiki/첫-노트.md",
        fileId: "file-0001",
        revision: createdMeta.revision,
        deleted: false,
      }),
    ]);

    const downloaded = await SELF.fetch(url("file", "30-wiki/첫-노트.md"), {
      headers: headers({ "if-match": createdMeta.revision }),
    });
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(first);

    const stale = await put(
      "30-wiki/첫-노트.md",
      new TextEncoder().encode("stale"),
      "file-0001",
      { "if-match": "not-current" },
    );
    expect(stale.status).toBe(412);

    const second = new TextEncoder().encode("# 수정됨\n");
    const updated = await put(
      "30-wiki/첫-노트.md",
      second,
      "file-0001",
      { "if-match": createdMeta.revision, "x-owen-operation-id": "operation-update-0001" },
    );
    expect(updated.status).toBe(200);

    const history = await listHistory("file-0001");
    expect(history.versions).toHaveLength(1);
    expect(history.versions[0]).toEqual(expect.objectContaining({
      path: "30-wiki/첫-노트.md",
      sha256: await digest(first),
      size: first.byteLength,
      deleted: false,
      sourceRevision: createdMeta.revision,
    }));
    const archived = await downloadHistory("file-0001", history.versions[0].versionId);
    expect(archived.status).toBe(200);
    expect(new Uint8Array(await archived.arrayBuffer())).toEqual(first);

    const isolatedIndex = await SELF.fetch(url("index"), { headers: headers() });
    const isolatedBody = await isolatedIndex.json<{ entries: Array<{ path: string }> }>();
    expect(isolatedBody.entries).toHaveLength(1);
    expect(isolatedBody.entries[0].path).toBe("30-wiki/첫-노트.md");
  });

  it("stores binary image bytes without rewriting them", async () => {
    const image = new Uint8Array(6 * 1024 * 1024);
    for (let index = 0; index < image.length; index += 1) image[index] = index % 251;
    const created = await put("attachments/photo.bin", image, "file-image-0001");
    expect(created.status).toBe(200);

    const downloaded = await SELF.fetch(url("file", "attachments/photo.bin"), { headers: headers() });
    expect(downloaded.status).toBe(200);
    const received = new Uint8Array(await downloaded.arrayBuffer());
    expect(received.byteLength).toBe(image.byteLength);
    expect(await digest(received)).toBe(await digest(image));
  });

  it("commits a multipart binary through staging with a conditional canonical write", async () => {
    const binary = new Uint8Array(12 * 1024 * 1024);
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 239;
    const hash = await digest(binary);
    const path = "attachments/large-image.bin";
    const priorBytes = new TextEncoder().encode("prior multipart revision");
    const prior = await put(path, priorBytes, "file-large-0001");
    expect(prior.status).toBe(200);
    const priorMeta = await prior.json<{ revision: string }>();
    const createUrl = new URL(url("multipart"));
    createUrl.searchParams.set("action", "create");
    createUrl.searchParams.set("path", path);
    const created = await SELF.fetch(createUrl, {
      method: "POST",
      headers: headers({
        "content-type": "application/octet-stream",
        "x-owen-file-id": "file-large-0001",
        "x-owen-sha256": hash,
        "x-owen-mtime": "3456",
        "x-owen-size": String(binary.byteLength),
        "x-owen-device-id": DEVICE,
        "x-owen-operation-id": "operation-multipart-0001",
      }),
    });
    expect(created.status).toBe(200);
    const session = await created.json<{ stagingKey: string; uploadId: string }>();

    const uploadedParts: Array<{ partNumber: number; etag: string }> = [];
    for (const [index, part] of [binary.slice(0, 8 * 1024 * 1024), binary.slice(8 * 1024 * 1024)].entries()) {
      const partUrl = new URL(url("multipart"));
      partUrl.searchParams.set("action", "part");
      partUrl.searchParams.set("stagingKey", session.stagingKey);
      partUrl.searchParams.set("uploadId", session.uploadId);
      partUrl.searchParams.set("partNumber", String(index + 1));
      const response = await SELF.fetch(partUrl, {
        method: "PUT",
        headers: headers(),
        body: part,
      });
      expect(response.status).toBe(200);
      uploadedParts.push(await response.json<{ partNumber: number; etag: string }>());
    }

    const completeUrl = new URL(url("multipart"));
    completeUrl.searchParams.set("action", "complete");
    completeUrl.searchParams.set("stagingKey", session.stagingKey);
    completeUrl.searchParams.set("uploadId", session.uploadId);
    const duplicateParts = await SELF.fetch(completeUrl, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ parts: [uploadedParts[0], uploadedParts[0]] }),
    });
    expect(duplicateParts.status).toBe(400);

    const completed = await SELF.fetch(completeUrl, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ parts: uploadedParts }),
    });
    expect(completed.status).toBe(200);

    const commitUrl = new URL(url("multipart"));
    commitUrl.searchParams.set("action", "commit");
    commitUrl.searchParams.set("stagingKey", session.stagingKey);
    commitUrl.searchParams.set("path", path);
    commitUrl.searchParams.set("fileId", "file-large-0001");
    commitUrl.searchParams.set("sha256", hash);
    const mismatchedCommitUrl = new URL(commitUrl);
    mismatchedCommitUrl.searchParams.set("sha256", "0".repeat(64));
    const mismatched = await SELF.fetch(mismatchedCommitUrl, {
      method: "POST",
      headers: headers({ "if-none-match": "*" }),
    });
    expect(mismatched.status).toBe(422);

    const committed = await SELF.fetch(commitUrl, {
      method: "POST",
      headers: headers({
        "if-match": priorMeta.revision,
        "x-owen-operation-id": "operation-multipart-0001",
      }),
    });
    expect(committed.status).toBe(200);
    const committedMeta = await committed.json<{ revision: string }>();

    const replayedCommit = await SELF.fetch(commitUrl, {
      method: "POST",
      headers: headers({
        "if-match": priorMeta.revision,
        "x-owen-operation-id": "operation-multipart-0001",
      }),
    });
    expect(replayedCommit.status).toBe(200);
    expect((await replayedCommit.json<{ revision: string }>()).revision).toBe(committedMeta.revision);

    const downloaded = await SELF.fetch(url("file", path), { headers: headers() });
    expect(downloaded.status).toBe(200);
    const received = new Uint8Array(await downloaded.arrayBuffer());
    expect(received.byteLength).toBe(binary.byteLength);
    expect(await digest(received)).toBe(hash);

    const history = await listHistory("file-large-0001");
    expect(history.versions).toHaveLength(1);
    const archived = await downloadHistory("file-large-0001", history.versions[0].versionId);
    expect(new Uint8Array(await archived.arrayBuffer())).toEqual(priorBytes);
  });

  it("uses a conditional tombstone instead of an unsafe remote delete", async () => {
    const bytes = new TextEncoder().encode("keep history locally");
    const created = await put("note.md", bytes, "file-delete-0001");
    const createdMeta = await created.json<{ revision: string }>();

    const tombstone = await SELF.fetch(url("file", "note.md"), {
      method: "PUT",
      headers: headers({
        "if-match": createdMeta.revision,
        "content-type": "application/x-owen-r2-tombstone",
        "x-owen-file-id": "file-delete-0001",
        "x-owen-sha256": EMPTY_SHA256,
        "x-owen-mtime": "2345",
        "x-owen-size": "0",
        "x-owen-device-id": DEVICE,
        "x-owen-deleted": "1",
      }),
      body: new Uint8Array(),
    });
    expect(tombstone.status).toBe(200);

    const download = await SELF.fetch(url("file", "note.md"), { headers: headers() });
    expect(download.status).toBe(410);
    const index = await SELF.fetch(url("index"), { headers: headers() });
    const body = await index.json<{ entries: Array<{ path: string; deleted: boolean }> }>();
    expect(body.entries).toEqual([expect.objectContaining({ path: "note.md", deleted: true })]);
  });

  it("moves by creating the destination before tombstoning the source", async () => {
    const bytes = new TextEncoder().encode("rename me");
    const created = await put("old.md", bytes, "file-move-0001");
    const createdMeta = await created.json<{ revision: string }>();

    const moved = await SELF.fetch(url("move"), {
      method: "POST",
      headers: headers({
        "content-type": "application/json",
        "x-owen-operation-id": "operation-move-0001",
      }),
      body: JSON.stringify({
        from: "old.md",
        to: "folder/new.md",
        fileId: "file-move-0001",
        expectedRevision: createdMeta.revision,
      }),
    });
    expect(moved.status).toBe(200);

    const index = await SELF.fetch(url("index"), { headers: headers() });
    const body = await index.json<{ entries: Array<{ path: string; fileId: string; deleted: boolean }> }>();
    expect(body.entries).toEqual([
      expect.objectContaining({ path: "folder/new.md", fileId: "file-move-0001", deleted: false }),
      expect.objectContaining({ path: "old.md", fileId: "file-move-0001", deleted: true }),
    ]);

    const history = await listHistory("file-move-0001");
    expect(history.versions).toHaveLength(1);
    expect(history.versions[0]).toEqual(expect.objectContaining({ path: "old.md", deleted: false }));
    const archived = await downloadHistory("file-move-0001", history.versions[0].versionId);
    expect(new TextDecoder().decode(await archived.arrayBuffer())).toBe("rename me");

    const retry = await SELF.fetch(url("move"), {
      method: "POST",
      headers: headers({
        "content-type": "application/json",
        "x-owen-operation-id": "operation-move-0001",
      }),
      body: JSON.stringify({
        from: "old.md",
        to: "folder/new.md",
        fileId: "file-move-0001",
        expectedRevision: createdMeta.revision,
      }),
    });
    expect(retry.status).toBe(200);
    expect((await listHistory("file-move-0001")).versions).toHaveLength(1);
  });
});

describe("immutable history protocol", () => {
  it("leaves a malformed canonical source untouched when archive validation fails", async () => {
    const path = "malformed-source.md";
    const body = new TextEncoder().encode("malformed metadata body");
    const key = `vaults/${VAULT}/files/${encodeURIComponent(path)}`;
    const stored = await env.VAULT.put(key, body, {
      customMetadata: {
        path,
        fileId: "file-malformed-0001",
        contentHash: await digest(body),
        clientMtime: "1234",
        contentSize: String(body.byteLength + 1),
        deviceId: DEVICE,
        deleted: "0",
      },
      httpMetadata: { contentType: "text/markdown" },
      sha256: await digest(body),
    });
    const update = await put(path, new TextEncoder().encode("replacement"), "file-malformed-0001", {
      "if-match": stored.etag,
      "x-owen-operation-id": "operation-malformed-0001",
    });
    expect(update.status).toBe(409);
    expect((await env.VAULT.head(key))?.etag).toBe(stored.etag);
    expect((await listHistory("file-malformed-0001")).versions).toHaveLength(0);
  });

  it("fails closed on a mismatched deterministic archive collision", async () => {
    const path = "collision.md";
    const original = new TextEncoder().encode("original collision source");
    const created = await put(path, original, "file-collision-0001");
    const createdMeta = await created.json<{ revision: string }>();
    const { source, versionId, key } = await expectedHistoryIdentity(path);
    const sourceMetadata = source.customMetadata ?? {};
    await env.VAULT.put(key, original, {
      customMetadata: {
        ...sourceMetadata,
        clientMtime: "9999",
        historySchema: "1",
        versionId,
        sourceRevision: source.etag,
        sourceVersion: source.version,
        sourceUploadedAt: source.uploaded.toISOString(),
        archivedAt: new Date().toISOString(),
      },
      httpMetadata: source.httpMetadata,
      sha256: String(sourceMetadata.contentHash),
    });

    const replacement = new TextEncoder().encode("must not commit");
    const update = await put(path, replacement, "file-collision-0001", {
      "if-match": createdMeta.revision,
      "x-owen-operation-id": "operation-collision-0001",
    });
    expect(update.status).toBe(409);
    const canonical = await SELF.fetch(url("file", path), { headers: headers() });
    expect(new Uint8Array(await canonical.arrayBuffer())).toEqual(original);

    const corruptDownload = await downloadHistory("file-collision-0001", versionId);
    expect(corruptDownload.status).toBe(409);
  });

  it("reconciles committed operation replays and rejects stale writers without duplicate history", async () => {
    const path = "replay.md";
    const first = new TextEncoder().encode("first");
    const second = new TextEncoder().encode("second");
    const created = await put(path, first, "file-replay-0001");
    const createdMeta = await created.json<{ revision: string }>();
    const operationHeaders = {
      "if-match": createdMeta.revision,
      "x-owen-operation-id": "operation-replay-0001",
    };
    const committed = await put(path, second, "file-replay-0001", operationHeaders);
    expect(committed.status).toBe(200);
    const committedMeta = await committed.json<{ revision: string }>();

    const replay = await put(path, second, "file-replay-0001", operationHeaders);
    expect(replay.status).toBe(200);
    expect((await replay.json<{ revision: string }>()).revision).toBe(committedMeta.revision);

    const stale = await put(path, new TextEncoder().encode("stale"), "file-replay-0001", {
      "if-match": createdMeta.revision,
      "x-owen-operation-id": "operation-stale-0001",
    });
    expect(stale.status).toBe(412);
    expect((await listHistory("file-replay-0001")).versions).toHaveLength(1);
    const canonical = await SELF.fetch(url("file", path), { headers: headers() });
    expect(new Uint8Array(await canonical.arrayBuffer())).toEqual(second);
  });

  it("rejects live file identity changes while allowing a tombstoned path to be reused", async () => {
    const path = "identity.md";
    const original = new TextEncoder().encode("stable identity");
    const created = await put(path, original, "file-identity-old");
    const createdMeta = await created.json<{ revision: string }>();
    const identitySwap = await put(path, new TextEncoder().encode("wrong identity"), "file-identity-new", {
      "if-match": createdMeta.revision,
      "x-owen-operation-id": "operation-identity-swap",
    });
    expect(identitySwap.status).toBe(412);
    expect((await listHistory("file-identity-old")).versions).toHaveLength(0);

    const tombstone = await SELF.fetch(url("file", path), {
      method: "PUT",
      headers: headers({
        "if-match": createdMeta.revision,
        "content-type": "application/x-owen-r2-tombstone",
        "x-owen-file-id": "file-identity-old",
        "x-owen-sha256": EMPTY_SHA256,
        "x-owen-mtime": "2000",
        "x-owen-size": "0",
        "x-owen-device-id": DEVICE,
        "x-owen-deleted": "1",
      }),
      body: new Uint8Array(),
    });
    const tombstoneMeta = await tombstone.json<{ revision: string }>();
    const reused = await put(path, new TextEncoder().encode("new file at old path"), "file-identity-new", {
      "if-match": tombstoneMeta.revision,
      "x-owen-operation-id": "operation-identity-reuse",
    });
    expect(reused.status).toBe(200);
    expect((await reused.json<{ fileId: string }>()).fileId).toBe("file-identity-new");
    expect((await listHistory("file-identity-old")).versions.some((version) => version.deleted)).toBe(true);
  });

  it("allows only one of two concurrent writers on the same source revision", async () => {
    const path = "concurrent.md";
    const original = new TextEncoder().encode("concurrent source");
    const created = await put(path, original, "file-concurrent-0001");
    const createdMeta = await created.json<{ revision: string }>();
    const [left, right] = await Promise.all([
      put(path, new TextEncoder().encode("left"), "file-concurrent-0001", {
        "if-match": createdMeta.revision,
        "x-owen-operation-id": "operation-concurrent-left",
      }),
      put(path, new TextEncoder().encode("right"), "file-concurrent-0001", {
        "if-match": createdMeta.revision,
        "x-owen-operation-id": "operation-concurrent-right",
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);
    expect((await listHistory("file-concurrent-0001")).versions).toHaveLength(1);
    const canonical = await SELF.fetch(url("file", path), { headers: headers() });
    expect(["left", "right"]).toContain(new TextDecoder().decode(await canonical.arrayBuffer()));
  });

  it("archives deletion, restores exact bytes, and makes restore replay idempotent", async () => {
    const path = "deleted.md";
    const original = new TextEncoder().encode("restore this exact body");
    const created = await put(path, original, "file-restore-0001");
    const createdMeta = await created.json<{ revision: string }>();
    const tombstone = await SELF.fetch(url("file", path), {
      method: "PUT",
      headers: headers({
        "if-match": createdMeta.revision,
        "content-type": "application/x-owen-r2-tombstone",
        "x-owen-file-id": "file-restore-0001",
        "x-owen-sha256": EMPTY_SHA256,
        "x-owen-mtime": "2000",
        "x-owen-size": "0",
        "x-owen-device-id": DEVICE,
        "x-owen-deleted": "1",
        "x-owen-operation-id": "operation-delete-0001",
      }),
      body: new Uint8Array(),
    });
    expect(tombstone.status).toBe(200);
    const tombstoneMeta = await tombstone.json<{ revision: string }>();
    const liveVersion = (await listHistory("file-restore-0001")).versions[0];

    const missingOperation = new URL(url("history/restore", path));
    missingOperation.searchParams.set("fileId", "file-restore-0001");
    missingOperation.searchParams.set("versionId", liveVersion.versionId);
    expect((await SELF.fetch(missingOperation, {
      method: "POST",
      headers: headers({
        "if-match": tombstoneMeta.revision,
        "x-owen-operation-id": "operation-restore-missing-id",
        "x-owen-mtime": "3000",
        "x-owen-device-id": DEVICE,
      }),
    })).status).toBe(400);

    const restoreUrl = new URL(url("history/restore", path));
    restoreUrl.searchParams.set("fileId", "file-restore-0001");
    restoreUrl.searchParams.set("versionId", liveVersion.versionId);
    const restoreHeaders = headers({
      "if-match": tombstoneMeta.revision,
      "x-owen-operation-id": "operation-restore-0001",
      "x-owen-restore-id": "restore-request-0001",
      "x-owen-mtime": "3000",
      "x-owen-device-id": DEVICE,
    });
    const restored = await SELF.fetch(restoreUrl, { method: "POST", headers: restoreHeaders });
    expect(restored.status).toBe(200);
    const restoredMeta = await restored.json<{ revision: string; fileId: string }>();
    expect(restoredMeta.fileId).toBe("file-restore-0001");
    const canonical = await SELF.fetch(url("file", path), { headers: headers() });
    expect(new Uint8Array(await canonical.arrayBuffer())).toEqual(original);

    const replay = await SELF.fetch(restoreUrl, { method: "POST", headers: restoreHeaders });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ revision: string }>()).revision).toBe(restoredMeta.revision);
    const mismatchedRestoreReplay = await SELF.fetch(restoreUrl, {
      method: "POST",
      headers: headers({
        "if-match": tombstoneMeta.revision,
        "x-owen-operation-id": "operation-restore-0001",
        "x-owen-restore-id": "restore-request-different",
        "x-owen-mtime": "3000",
        "x-owen-device-id": DEVICE,
      }),
    });
    expect(mismatchedRestoreReplay.status).toBe(409);
    const versions = (await listHistory("file-restore-0001")).versions;
    expect(versions).toHaveLength(2);
    const archivedTombstone = versions.find((version) => version.deleted);
    expect(archivedTombstone).toBeDefined();
    expect((await downloadHistory("file-restore-0001", archivedTombstone!.versionId)).status).toBe(410);

    const stale = await SELF.fetch(restoreUrl, {
      method: "POST",
      headers: headers({
        "if-match": tombstoneMeta.revision,
        "x-owen-operation-id": "operation-restore-stale-0001",
        "x-owen-restore-id": "restore-request-stale-0001",
        "x-owen-mtime": "4000",
        "x-owen-device-id": DEVICE,
      }),
    });
    expect(stale.status).toBe(412);

    const wrongPath = new URL(restoreUrl);
    wrongPath.searchParams.set("path", "different.md");
    expect((await SELF.fetch(wrongPath, {
      method: "POST",
      headers: headers({
        "if-match": restoredMeta.revision,
        "x-owen-operation-id": "operation-restore-path-0001",
        "x-owen-restore-id": "restore-request-path-0001",
        "x-owen-mtime": "5000",
        "x-owen-device-id": DEVICE,
      }),
    })).status).toBe(412);
  });

  it("rejects a moved tombstone restore when the live identity is on a later canonical page", async () => {
    const from = "old.md";
    const to = "zzz-current.md";
    const fileId = "file-moved-restore-0001";
    const original = new TextEncoder().encode("moved restore body");

    for (let start = 0; start < 1000; start += 100) {
      await Promise.all(Array.from({ length: 100 }, async (_, offset) => {
        const index = start + offset;
        const path = `page/${String(index).padStart(4, "0")}.md`;
        const stored = await env.VAULT.put(
          `vaults/${VAULT}/files/${encodeURIComponent(path)}`,
          new Uint8Array(),
          {
            onlyIf: { etagDoesNotMatch: "*" },
            customMetadata: {
              path,
              fileId: `file-page-${String(index).padStart(4, "0")}`,
              contentHash: EMPTY_SHA256,
              clientMtime: "1",
              contentSize: "0",
              deviceId: DEVICE,
              deleted: "0",
            },
            httpMetadata: { contentType: "text/markdown" },
            sha256: EMPTY_SHA256,
          },
        );
        expect(stored).not.toBeNull();
      }));
    }

    const created = await put(from, original, fileId);
    const createdMeta = await created.json<{ revision: string }>();
    const moved = await SELF.fetch(url("move"), {
      method: "POST",
      headers: headers({
        "content-type": "application/json",
        "x-owen-operation-id": "operation-moved-restore",
      }),
      body: JSON.stringify({
        from,
        to,
        fileId,
        expectedRevision: createdMeta.revision,
      }),
    });
    expect(moved.status).toBe(200);
    const movedMeta = await moved.json<{ revision: string }>();
    const liveVersion = (await listHistory(fileId)).versions[0];

    const firstCanonicalPage = await env.VAULT.list({
      prefix: `vaults/${VAULT}/files/`,
      limit: 1000,
      include: ["customMetadata"],
    });
    expect(firstCanonicalPage.truncated).toBe(true);
    expect(firstCanonicalPage.objects.some((object) => object.customMetadata?.path === to)).toBe(false);

    const restoreOldUrl = new URL(url("history/restore", from));
    restoreOldUrl.searchParams.set("fileId", fileId);
    restoreOldUrl.searchParams.set("versionId", liveVersion.versionId);
    const beforeRejectedRestore = await snapshotVaultObjects();
    const rejected = await SELF.fetch(restoreOldUrl, {
      method: "POST",
      headers: headers({
        "if-match": (await env.VAULT.head(`vaults/${VAULT}/files/${encodeURIComponent(from)}`))!.etag,
        "x-owen-operation-id": "operation-restore-old-path",
        "x-owen-restore-id": "restore-request-old-path",
        "x-owen-mtime": "3000",
        "x-owen-device-id": DEVICE,
      }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual(expect.objectContaining({ error: "duplicate_live_file_id" }));
    expect(await snapshotVaultObjects()).toEqual(beforeRejectedRestore);

    const restoreCurrentUrl = new URL(url("history/restore", to));
    restoreCurrentUrl.searchParams.set("fileId", fileId);
    restoreCurrentUrl.searchParams.set("versionId", liveVersion.versionId);
    const restoreCurrentHeaders = headers({
      "if-match": movedMeta.revision,
      "x-owen-operation-id": "operation-restore-current",
      "x-owen-restore-id": "restore-request-current",
      "x-owen-mtime": "4000",
      "x-owen-device-id": DEVICE,
    });
    const restored = await SELF.fetch(restoreCurrentUrl, {
      method: "POST",
      headers: restoreCurrentHeaders,
    });
    expect(restored.status).toBe(200);
    const restoredMeta = await restored.json<{ revision: string }>();
    const canonical = await SELF.fetch(url("file", to), { headers: headers() });
    expect(new Uint8Array(await canonical.arrayBuffer())).toEqual(original);

    const replay = await SELF.fetch(restoreCurrentUrl, {
      method: "POST",
      headers: restoreCurrentHeaders,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ revision: string }>()).revision).toBe(restoredMeta.revision);
  }, 30_000);

  it("resumes a destination-only move without creating another history version", async () => {
    const from = "partial-old.md";
    const to = "partial/new.md";
    const body = new TextEncoder().encode("partial move body");
    const created = await put(from, body, "file-partial-0001");
    const createdMeta = await created.json<{ revision: string }>();
    const source = await env.VAULT.head(`vaults/${VAULT}/files/${encodeURIComponent(from)}`);
    if (!source) throw new Error("missing partial move source");
    await env.VAULT.put(`vaults/${VAULT}/files/${encodeURIComponent(to)}`, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        ...(source.customMetadata ?? {}),
        path: to,
        operationId: "operation-partial-0001",
      },
      httpMetadata: source.httpMetadata,
      sha256: String(source.customMetadata?.contentHash),
    });

    const resumed = await SELF.fetch(url("move"), {
      method: "POST",
      headers: headers({
        "content-type": "application/json",
        "x-owen-operation-id": "operation-partial-0001",
      }),
      body: JSON.stringify({
        from,
        to,
        fileId: "file-partial-0001",
        expectedRevision: createdMeta.revision,
      }),
    });
    expect(resumed.status).toBe(200);
    expect((await listHistory("file-partial-0001")).versions).toHaveLength(1);
    expect((await SELF.fetch(url("file", from), { headers: headers() })).status).toBe(410);
  });

  it("paginates newest-first metadata, validates inputs, and keeps history out of the default index", async () => {
    const path = "pagination.md";
    const fileId = "file-pagination-0001";
    let response = await put(path, new TextEncoder().encode("v0"), fileId);
    let revision = (await response.json<{ revision: string }>()).revision;
    for (let index = 1; index <= 3; index += 1) {
      response = await put(path, new TextEncoder().encode(`v${index}`), fileId, {
        "if-match": revision,
        "x-owen-operation-id": `operation-page-${String(index).padStart(4, "0")}`,
      });
      expect(response.status).toBe(200);
      revision = (await response.json<{ revision: string }>()).revision;
    }

    const firstPage = await listHistory(fileId, { limit: 2 });
    expect(firstPage.versions).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(Date.parse(firstPage.versions[0].sourceUploadedAt))
      .toBeGreaterThanOrEqual(Date.parse(firstPage.versions[1].sourceUploadedAt));
    const secondPage = await listHistory(fileId, { limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.versions).toHaveLength(1);
    expect(new Set([...firstPage.versions, ...secondPage.versions].map((version) => version.versionId)).size).toBe(3);

    const index = await SELF.fetch(url("index"), { headers: headers() });
    const indexBody = await index.json<{ entries: Array<{ path: string }> }>();
    expect(indexBody.entries).toEqual([expect.objectContaining({ path })]);

    const invalidLimit = new URL(url("history"));
    invalidLimit.searchParams.set("fileId", fileId);
    invalidLimit.searchParams.set("limit", "201");
    expect((await SELF.fetch(invalidLimit, { headers: headers() })).status).toBe(400);
    expect((await SELF.fetch(invalidLimit)).status).toBe(401);

    const invalidVersion = new URL(url("history/file"));
    invalidVersion.searchParams.set("fileId", fileId);
    invalidVersion.searchParams.set("versionId", "not-a-version");
    expect((await SELF.fetch(invalidVersion, { headers: headers() })).status).toBe(400);
    expect((await SELF.fetch(invalidVersion, { method: "DELETE", headers: headers() })).status).toBe(404);
  });
});
