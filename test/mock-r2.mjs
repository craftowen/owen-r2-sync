import http from "node:http";
import { createHash } from "node:crypto";

const TOKEN = "mock-r2-token-with-at-least-32-bytes";

function sha256(buffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

export function startMockR2Worker(port = 0) {
  const objects = new Map();
  let revision = 0;
  let indexRequests = 0;
  let historyRequests = 0;
  let historyDownloadRequests = 0;
  let failAfterCommit = false;
  const state = { rejectPath: null, rejectHistoryArchive: false, historyProtocol: 1 };
  const multipart = new Map();
  const completedStages = new Map();
  const history = new Map();

  const nextRevision = () => `rev-${++revision}`;
  const sendJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const historyMetadata = (entry) => ({
    versionId: entry.versionId,
    fileId: entry.fileId,
    path: entry.path,
    sha256: entry.hash,
    size: entry.body.byteLength,
    mtime: entry.mtime,
    deviceId: entry.deviceId,
    deleted: entry.deleted,
    sourceRevision: entry.sourceRevision,
    sourceVersion: entry.sourceVersion,
    sourceUploadedAt: entry.sourceUploadedAt,
    archivedAt: entry.archivedAt,
    contentType: entry.contentType,
    archiveRevision: entry.archiveRevision,
    ...(entry.operationId ? { operationId: entry.operationId } : {}),
    ...(entry.lastRestoreId ? { lastRestoreId: entry.lastRestoreId } : {}),
  });
  const archive = (entry) => {
    if (state.rejectHistoryArchive) throw new Error("Injected history archive rejection.");
    const versionId = `${entry.revision}-${entry.hash.slice(0, 16)}`;
    const versions = history.get(entry.fileId) ?? [];
    const existing = versions.find((version) => version.versionId === versionId);
    if (existing) {
      if (
        existing.path !== entry.path ||
        existing.hash !== entry.hash ||
        existing.sourceRevision !== entry.revision
      ) throw new Error("history collision");
      return existing;
    }
    const version = {
      ...entry,
      body: entry.body.slice(0),
      versionId,
      sourceRevision: entry.revision,
      sourceVersion: entry.revision,
      sourceUploadedAt: entry.uploadedAt ?? new Date().toISOString(),
      archivedAt: new Date().toISOString(),
      archiveRevision: `archive-${versionId}`,
    };
    versions.unshift(version);
    history.set(entry.fileId, versions);
    return version;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      sendJson(res, 401, { error: "unauthorized", message: "Authentication failed." });
      return;
    }

    if (url.pathname === "/v1/health") {
      sendJson(res, 200, {
        ok: true,
        ...(state.historyProtocol === 1 ? { historyProtocol: 1 } : {}),
      });
      return;
    }
    if (url.pathname === "/v1/index") {
      indexRequests++;
      sendJson(res, 200, {
        entries: [...objects.values()].map((entry) => ({
          path: entry.path,
          fileId: entry.fileId,
          contentHash: entry.hash,
          clientMtime: entry.mtime,
          contentSize: entry.body.byteLength,
          deviceId: entry.deviceId,
          deleted: entry.deleted,
          revision: entry.revision,
          uploadedAt: entry.uploadedAt ?? new Date().toISOString(),
          contentType: entry.contentType,
        })),
      });
      return;
    }

    if (url.pathname === "/v1/history" && req.method === "GET") {
      historyRequests++;
      const fileId = url.searchParams.get("fileId");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      if (!fileId || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
        sendJson(res, 400, { error: "invalid_history_query", message: "invalid history query" });
        return;
      }
      const versions = history.get(fileId) ?? [];
      const page = versions.slice(offset, offset + limit);
      sendJson(res, 200, {
        historyProtocol: 1,
        fileId,
        versions: page.map(historyMetadata),
        nextCursor: offset + page.length < versions.length ? String(offset + page.length) : null,
      });
      return;
    }

    if (url.pathname === "/v1/history/file" && (req.method === "GET" || req.method === "HEAD")) {
      historyRequests++;
      if (req.method === "GET") historyDownloadRequests++;
      const fileId = url.searchParams.get("fileId");
      const versionId = url.searchParams.get("versionId");
      const version = (history.get(fileId) ?? []).find((candidate) => candidate.versionId === versionId);
      if (!version) {
        sendJson(res, 404, { error: "history_not_found", message: "missing history version" });
        return;
      }
      if (version.deleted && req.method === "GET") {
        sendJson(res, 410, { error: "history_deleted", message: "deleted history marker" });
        return;
      }
      const headers = {
        "content-type": version.contentType,
        etag: `"${version.archiveRevision}"`,
        "x-owen-file-id": version.fileId,
        "x-owen-sha256": version.hash,
        "x-owen-mtime": String(version.mtime),
        "x-owen-size": String(version.body.byteLength),
        "x-owen-device-id": version.deviceId,
        "x-owen-deleted": version.deleted ? "1" : "0",
        "x-owen-history-version-id": version.versionId,
        "x-owen-source-revision": version.sourceRevision,
        "x-owen-source-version": version.sourceVersion,
        "x-owen-source-uploaded-at": version.sourceUploadedAt,
        "x-owen-archived-at": version.archivedAt,
        ...(version.operationId ? { "x-owen-operation-id": version.operationId } : {}),
        ...(version.lastRestoreId ? { "x-owen-restore-id": version.lastRestoreId } : {}),
      };
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : Buffer.from(version.body));
      return;
    }

    if (url.pathname === "/v1/history/restore" && req.method === "POST") {
      historyRequests++;
      const fileId = url.searchParams.get("fileId");
      const versionId = url.searchParams.get("versionId");
      const path = url.searchParams.get("path");
      const version = (history.get(fileId) ?? []).find((candidate) => candidate.versionId === versionId);
      const current = objects.get(path);
      const operationId = String(req.headers["x-owen-operation-id"] ?? "");
      const restoreId = String(req.headers["x-owen-restore-id"] ?? "");
      if (!version || version.deleted) {
        sendJson(res, 410, { error: "history_not_restorable", message: "history version is not live" });
        return;
      }
      if (
        current?.operationId === operationId &&
        current?.lastRestoreId === restoreId &&
        current?.hash === version.hash
      ) {
        sendJson(res, 200, {
          path,
          fileId: current.fileId,
          revision: current.revision,
          sha256: current.hash,
          size: current.body.byteLength,
          mtime: current.mtime,
          deleted: false,
        });
        return;
      }
      if (!current || current.fileId !== fileId || req.headers["if-match"] !== current.revision) {
        sendJson(res, 412, { error: "precondition_failed", message: "restore target changed" });
        return;
      }
      try {
        archive(current);
      } catch (error) {
        sendJson(res, 503, { error: "history_archive_failed", message: error.message });
        return;
      }
      const restored = {
        ...version,
        path,
        fileId,
        deleted: false,
        revision: nextRevision(),
        mtime: Number(req.headers["x-owen-mtime"]),
        deviceId: String(req.headers["x-owen-device-id"]),
        operationId,
        lastRestoreId: restoreId,
        uploadedAt: new Date().toISOString(),
        body: version.body.slice(0),
      };
      objects.set(path, restored);
      if (failAfterCommit) {
        failAfterCommit = false;
        req.socket.destroy();
        return;
      }
      sendJson(res, 200, {
        path,
        fileId,
        revision: restored.revision,
        sha256: restored.hash,
        size: restored.body.byteLength,
        mtime: restored.mtime,
        deleted: false,
      });
      return;
    }

    if (url.pathname === "/v1/multipart") {
      const action = url.searchParams.get("action");
      if (action === "create" && req.method === "POST") {
        const path = url.searchParams.get("path");
        const uploadId = `upload-${nextRevision()}`;
        const stagingKey = `vaults/owen-mobile/staging/${req.headers["x-owen-file-id"]}/${uploadId}`;
        multipart.set(uploadId, {
          stagingKey,
          path,
          fileId: String(req.headers["x-owen-file-id"]),
          hash: String(req.headers["x-owen-sha256"]),
          mtime: Number(req.headers["x-owen-mtime"]),
          deviceId: String(req.headers["x-owen-device-id"]),
          operationId: String(req.headers["x-owen-operation-id"] ?? ""),
          contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
          parts: new Map(),
        });
        sendJson(res, 200, { uploadId, stagingKey });
        return;
      }
      const uploadId = url.searchParams.get("uploadId");
      const session = uploadId ? multipart.get(uploadId) : null;
      if (action === "part" && req.method === "PUT" && session) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const partNumber = Number(url.searchParams.get("partNumber"));
        const etag = sha256(body).slice(0, 32);
        session.parts.set(partNumber, { body, etag });
        sendJson(res, 200, { partNumber, etag });
        return;
      }
      if (action === "complete" && req.method === "POST" && session) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const bodies = payload.parts.map((part) => session.parts.get(part.partNumber)?.body);
        if (bodies.some((body) => !body)) {
          sendJson(res, 400, { error: "invalid_parts", message: "missing" });
          return;
        }
        const body = Buffer.concat(bodies);
        completedStages.set(session.stagingKey, { ...session, body });
        multipart.delete(uploadId);
        sendJson(res, 200, { stagingKey: session.stagingKey, revision: nextRevision(), size: body.byteLength });
        return;
      }
      if (action === "abort" && req.method === "POST") {
        if (uploadId) multipart.delete(uploadId);
        sendJson(res, 200, { aborted: true });
        return;
      }
      if (action === "commit" && req.method === "POST") {
        const stagingKey = url.searchParams.get("stagingKey");
        const stage = stagingKey ? completedStages.get(stagingKey) : null;
        const path = url.searchParams.get("path");
        const existing = objects.get(path);
        if (!stage) {
          if (
            existing &&
            existing.fileId === url.searchParams.get("fileId") &&
            existing.hash === url.searchParams.get("sha256")
          ) {
            sendJson(res, 200, {
              path,
              fileId: existing.fileId,
              revision: existing.revision,
              sha256: existing.hash,
              size: existing.body.byteLength,
              mtime: existing.mtime,
              deleted: false,
            });
            return;
          }
          sendJson(res, 404, { error: "staging_missing", message: "missing" });
          return;
        }
        if (req.headers["if-none-match"] === "*" && existing) {
          sendJson(res, 412, { error: "precondition_failed", message: "exists" });
          return;
        }
        if (req.headers["if-match"] && req.headers["if-match"] !== existing?.revision) {
          sendJson(res, 412, { error: "precondition_failed", message: "changed" });
          return;
        }
        if (existing) {
          try {
            archive(existing);
          } catch (error) {
            sendJson(res, 503, { error: "history_archive_failed", message: error.message });
            return;
          }
        }
        const entry = {
          path,
          fileId: stage.fileId,
          hash: stage.hash,
          mtime: stage.mtime,
          deviceId: stage.deviceId,
          operationId: stage.operationId,
          deleted: false,
          revision: nextRevision(),
          uploadedAt: new Date().toISOString(),
          contentType: stage.contentType,
          body: stage.body.buffer.slice(stage.body.byteOffset, stage.body.byteOffset + stage.body.byteLength),
        };
        objects.set(path, entry);
        completedStages.delete(stagingKey);
        sendJson(res, 200, {
          path,
          fileId: entry.fileId,
          revision: entry.revision,
          sha256: entry.hash,
          size: entry.body.byteLength,
          mtime: entry.mtime,
          deleted: false,
        });
        return;
      }
    }

    const path = url.searchParams.get("path");
    if (url.pathname === "/v1/file" && path) {
      const existing = objects.get(path);
      if (req.method === "GET" || req.method === "HEAD") {
        if (!existing) {
          sendJson(res, 404, { error: "not_found", message: "missing" });
          return;
        }
        if (req.headers["if-match"] && req.headers["if-match"] !== existing.revision) {
          sendJson(res, 412, { error: "precondition_failed", message: "changed" });
          return;
        }
        const headers = {
          etag: `"${existing.revision}"`,
          "content-type": existing.contentType,
          "x-owen-file-id": existing.fileId,
          "x-owen-sha256": existing.hash,
          "x-owen-mtime": String(existing.mtime),
          "x-owen-size": String(existing.body.byteLength),
          "x-owen-device-id": existing.deviceId,
          "x-owen-deleted": existing.deleted ? "1" : "0",
          "x-owen-operation-id": existing.operationId ?? "",
          ...(existing.lastRestoreId ? { "x-owen-restore-id": existing.lastRestoreId } : {}),
        };
        if (existing.deleted && req.method === "GET") {
          sendJson(res, 410, { error: "deleted", message: "deleted" }, headers);
          return;
        }
        res.writeHead(200, headers);
        res.end(req.method === "HEAD" ? undefined : Buffer.from(existing.body));
        return;
      }
      if (req.method === "PUT") {
        if (state.rejectPath === path) {
          sendJson(res, 413, { error: "injected_rejection", message: "Injected upload rejection." });
          return;
        }
        if (req.headers["if-none-match"] === "*" && existing) {
          sendJson(res, 412, { error: "precondition_failed", message: "exists" });
          return;
        }
        if (req.headers["if-match"] && req.headers["if-match"] !== existing?.revision) {
          sendJson(res, 412, { error: "precondition_failed", message: "changed" });
          return;
        }
        if (existing) {
          try {
            archive(existing);
          } catch (error) {
            sendJson(res, 503, { error: "history_archive_failed", message: error.message });
            return;
          }
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const declaredHash = String(req.headers["x-owen-sha256"] ?? "");
        if (sha256(body) !== declaredHash) {
          sendJson(res, 422, { error: "hash_mismatch", message: "bad hash" });
          return;
        }
        const entry = {
          path,
          fileId: String(req.headers["x-owen-file-id"]),
          hash: declaredHash,
          mtime: Number(req.headers["x-owen-mtime"]),
          deviceId: String(req.headers["x-owen-device-id"]),
          operationId: String(req.headers["x-owen-operation-id"] ?? ""),
          deleted: req.headers["x-owen-deleted"] === "1",
          revision: nextRevision(),
          uploadedAt: new Date().toISOString(),
          contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
          body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
        objects.set(path, entry);
        if (failAfterCommit) {
          failAfterCommit = false;
          req.socket.destroy();
          return;
        }
        sendJson(res, 200, {
          path,
          fileId: entry.fileId,
          revision: entry.revision,
          sha256: entry.hash,
          size: body.byteLength,
          mtime: entry.mtime,
          deleted: entry.deleted,
        });
        return;
      }
    }

    if (url.pathname === "/v1/move" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const source = objects.get(move.from);
      const destination = objects.get(move.to);
      if (destination && !destination.deleted && destination.fileId === move.fileId && source?.deleted) {
        sendJson(res, 200, {
          path: move.to,
          fileId: destination.fileId,
          revision: destination.revision,
          sha256: destination.hash,
          size: destination.body.byteLength,
          mtime: destination.mtime,
          deleted: false,
        });
        return;
      }
      if (!source || source.deleted || source.revision !== move.expectedRevision || destination) {
        sendJson(res, 412, { error: "precondition_failed", message: "move conflict" });
        return;
      }
      try {
        archive(source);
      } catch (error) {
        sendJson(res, 503, { error: "history_archive_failed", message: error.message });
        return;
      }
      const moved = {
        ...source,
        path: move.to,
        revision: nextRevision(),
        operationId: String(req.headers["x-owen-operation-id"] ?? ""),
        deviceId: String(req.headers["x-owen-device-id"] ?? source.deviceId),
        uploadedAt: new Date().toISOString(),
      };
      objects.set(move.to, moved);
      objects.set(move.from, {
        ...source,
        hash: sha256(new ArrayBuffer(0)),
        deleted: true,
        revision: nextRevision(),
        operationId: String(req.headers["x-owen-operation-id"] ?? ""),
        uploadedAt: new Date().toISOString(),
        body: new ArrayBuffer(0),
      });
      sendJson(res, 200, {
        path: move.to,
        fileId: moved.fileId,
        revision: moved.revision,
        sha256: moved.hash,
        size: moved.body.byteLength,
        mtime: moved.mtime,
        deleted: false,
      });
      return;
    }

    sendJson(res, 404, { error: "not_found", message: "route" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        workerUrl: `http://127.0.0.1:${actualPort}`,
        token: TOKEN,
        objects,
        history,
        state,
        get indexRequests() { return indexRequests; },
        resetIndexRequests() { indexRequests = 0; },
        get historyRequests() { return historyRequests; },
        resetHistoryRequests() { historyRequests = 0; },
        get historyDownloadRequests() { return historyDownloadRequests; },
        resetHistoryDownloadRequests() { historyDownloadRequests = 0; },
        failNextResponseAfterCommit() { failAfterCommit = true; },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
