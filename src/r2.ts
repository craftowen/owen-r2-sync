import { type RequestUrlResponse, requestUrl } from "obsidian";
import { assertSafeRemotePath, sha256Hex } from "./safety";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;
const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
const MULTIPART_CONCURRENCY = 2;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface R2File {
  id: string;
  name: string;
  path: string;
  revision: string;
  md5Checksum: string;
  modifiedTime: string;
  uploadedTime?: string;
  size: string;
  deleted: boolean;
}

export interface R2Health {
  historyProtocol: 1 | null;
}

export interface R2HistoryVersion {
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
  archiveRevision: string;
  operationId?: string;
  lastRestoreId?: string;
}

export interface R2HistoryPage {
  versions: R2HistoryVersion[];
  nextCursor: string | null;
}

interface R2IndexEntry {
  path: string;
  fileId: string;
  contentHash: string;
  clientMtime: number;
  contentSize: number;
  deviceId: string;
  deleted: boolean;
  revision: string;
  uploadedAt: string;
  contentType: string;
}

interface R2MutationResponse {
  path: string;
  fileId: string;
  revision: string;
  sha256: string;
  size: number;
  mtime: number;
  deleted: boolean;
}

interface R2HistoryEntry {
  versionId: unknown;
  fileId: unknown;
  path: unknown;
  sha256: unknown;
  size: unknown;
  mtime: unknown;
  deviceId: unknown;
  deleted: unknown;
  sourceRevision: unknown;
  sourceVersion: unknown;
  sourceUploadedAt: unknown;
  archivedAt: unknown;
  contentType: unknown;
  archiveRevision: unknown;
  operationId?: unknown;
  lastRestoreId?: unknown;
}

export class R2HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function responseHeader(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function normalizeRevision(value: string | null | undefined): string {
  return (value ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

function requiredRevision(value: unknown, name: string): string {
  const revision = normalizeRevision(requiredString(value, name, 256));
  if (!revision) throw new Error(`R2 Worker returned an invalid ${name}.`);
  return revision;
}

function requiredString(value: unknown, name: string, maxLength = 512): string {
  const hasControl = typeof value === "string" && [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || hasControl) {
    throw new Error(`R2 Worker returned an invalid ${name}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`R2 Worker returned an invalid ${name}.`);
  }
  return value;
}

function isoTimestamp(value: unknown, name: string): string {
  const text = requiredString(value, name, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`R2 Worker returned an invalid ${name}.`);
  return text;
}

function toHistoryVersion(raw: unknown): R2HistoryVersion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("R2 Worker history contains an invalid version.");
  }
  const entry = raw as R2HistoryEntry;
  const path = requiredString(entry.path, "history path");
  assertSafeRemotePath(path);
  const sha256 = requiredString(entry.sha256, "history SHA-256", 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("R2 Worker returned an invalid history SHA-256.");
  if (typeof entry.deleted !== "boolean") throw new Error("R2 Worker returned an invalid history deletion flag.");
  return {
    versionId: requiredString(entry.versionId, "history version ID", 256),
    fileId: requiredString(entry.fileId, "history file ID", 256),
    path,
    sha256,
    size: nonNegativeInteger(entry.size, "history size"),
    mtime: nonNegativeInteger(entry.mtime, "history mtime"),
    deviceId: requiredString(entry.deviceId, "history device ID", 256),
    deleted: entry.deleted,
    sourceRevision: requiredRevision(entry.sourceRevision, "history source revision"),
    sourceVersion: requiredString(entry.sourceVersion, "history source version", 256),
    sourceUploadedAt: isoTimestamp(entry.sourceUploadedAt, "history source upload time"),
    archivedAt: isoTimestamp(entry.archivedAt, "history archive time"),
    contentType: requiredString(entry.contentType, "history content type", 256),
    archiveRevision: requiredRevision(entry.archiveRevision, "history archive revision"),
    ...(entry.operationId === undefined
      ? {}
      : { operationId: requiredString(entry.operationId, "history operation ID", 64) }),
    ...(entry.lastRestoreId === undefined
      ? {}
      : { lastRestoreId: requiredString(entry.lastRestoreId, "history restore ID", 64) }),
  };
}

function mimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    avif: "image/avif",
    canvas: "application/json",
    css: "text/css",
    csv: "text/csv",
    gif: "image/gif",
    heic: "image/heic",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    mjs: "text/javascript",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
  };
  return known[extension] ?? "application/octet-stream";
}

function parseError(response: RequestUrlResponse): R2HttpError {
  const body = response.json as { error?: unknown; message?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error : `http_${response.status}`;
  const message = typeof body?.message === "string"
    ? body.message
    : `R2 sync Worker returned HTTP ${response.status}.`;
  return new R2HttpError(response.status, code, message);
}

function toFile(entry: R2IndexEntry): R2File {
  assertSafeRemotePath(entry.path);
  if (!entry.fileId || !entry.revision || !/^[a-f0-9]{64}$/.test(entry.contentHash)) {
    throw new Error(`R2 index entry is incomplete: ${entry.path}`);
  }
  return {
    id: entry.fileId,
    name: entry.path.split("/").pop() ?? entry.path,
    path: entry.path,
    revision: normalizeRevision(entry.revision),
    md5Checksum: entry.contentHash,
    modifiedTime: new Date(entry.clientMtime).toISOString(),
    uploadedTime: isoTimestamp(entry.uploadedAt, "R2 upload time"),
    size: String(entry.contentSize),
    deleted: entry.deleted,
  };
}

export class R2Client {
  private pathByFileId = new Map<string, string>();
  private liveFiles = new Map<string, R2File>();
  private tombstones = new Map<string, R2File>();
  private historyVersions = new Map<string, R2HistoryVersion>();
  private historyProtocol: 1 | null = null;

  constructor(
    private workerUrl: string,
    private vaultId: string,
    private apiToken: string,
    private deviceId: string
  ) {
    this.workerUrl = this.workerUrl.replace(/\/$/, "");
    const parsed = new URL(this.workerUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new Error("R2 sync Worker URL must use HTTPS.");
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(this.vaultId)) {
      throw new Error("R2 vault ID must be a lowercase slug.");
    }
    if (this.apiToken.length < 24) throw new Error("R2 sync token is too short.");
  }

  private url(route: string, path?: string): string {
    const url = new URL(`${this.workerUrl}/v1/${route}`);
    url.searchParams.set("vault", this.vaultId);
    if (path !== undefined) url.searchParams.set("path", path);
    return url.toString();
  }

  private async call(
    route: string,
    options: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string | ArrayBuffer;
      retry?: boolean;
    } = {}
  ): Promise<RequestUrlResponse> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await requestUrl({
          url: this.url(route, options.path),
          method: options.method ?? "GET",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: options.body } : {}),
          throw: false,
        });
        if (response.status >= 200 && response.status < 300) return response;
        const error = parseError(response);
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof R2HttpError && error.status < 500 && error.status !== 429) throw error;
        lastError = error;
      }
      if (options.retry === false || attempt === MAX_RETRIES - 1) break;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error("R2 Worker request failed.");
  }

  async health(): Promise<R2Health> {
    const response = await this.call("health");
    const payload = response.json as { ok?: unknown; historyProtocol?: unknown } | null;
    if (!payload || payload.ok !== true) throw new Error("R2 Worker returned an invalid health response.");
    if (payload.historyProtocol !== undefined && payload.historyProtocol !== 1) {
      throw new Error("R2 Worker advertised an unsupported history protocol.");
    }
    this.historyProtocol = payload.historyProtocol === 1 ? 1 : null;
    return { historyProtocol: this.historyProtocol };
  }

  get supportsHistory(): boolean {
    return this.historyProtocol === 1;
  }

  async findFolder(_name: string): Promise<string> {
    await this.health();
    return this.vaultId;
  }

  async ensureFolder(_name: string): Promise<string> {
    await this.health();
    return this.vaultId;
  }

  async verifyFolder(id: string): Promise<void> {
    if (id !== this.vaultId) throw new Error("Configured R2 vault identity changed.");
  }

  async ensurePath(
    rootId: string,
    parts: string[],
    _cache: Map<string, string>
  ): Promise<string> {
    if (rootId !== this.vaultId) throw new Error("Configured R2 vault identity changed.");
    return parts.join("/");
  }

  async listTree(_rootId: string): Promise<Map<string, R2File & { path: string }>> {
    const response = await this.call("index");
    const payload = response.json as { entries?: unknown };
    if (!Array.isArray(payload.entries)) throw new Error("R2 Worker returned an invalid index.");

    const live = new Map<string, R2File & { path: string }>();
    const liveFiles = new Map<string, R2File>();
    const pathByFileId = new Map<string, string>();
    const tombstones = new Map<string, R2File>();
    for (const raw of payload.entries) {
      if (!raw || typeof raw !== "object") throw new Error("R2 Worker index contains an invalid entry.");
      const file = toFile(raw as R2IndexEntry);
      if (file.deleted) {
        tombstones.set(file.path, file);
        continue;
      }
      const previousPath = pathByFileId.get(file.id);
      if (previousPath && previousPath !== file.path) {
        throw new Error(`R2 contains duplicate live file identity '${file.id}'.`);
      }
      pathByFileId.set(file.id, file.path);
      liveFiles.set(file.id, file);
      live.set(file.path, file);
    }
    this.pathByFileId = pathByFileId;
    this.liveFiles = liveFiles;
    this.tombstones = tombstones;
    return live;
  }

  currentFile(fileId: string): R2File | null {
    const live = this.liveFiles.get(fileId);
    if (live) return live;
    return this.deletedFiles().find((file) => file.id === fileId) ?? null;
  }

  deletedFiles(): R2File[] {
    const latestByFileId = new Map<string, R2File>();
    for (const file of this.tombstones.values()) {
      if (this.pathByFileId.has(file.id)) continue;
      const previous = latestByFileId.get(file.id);
      const fileTime = Date.parse(file.uploadedTime ?? file.modifiedTime);
      const previousTime = previous
        ? Date.parse(previous.uploadedTime ?? previous.modifiedTime)
        : Number.NEGATIVE_INFINITY;
      if (!previous || fileTime > previousTime) {
        latestByFileId.set(file.id, file);
      }
    }
    return [...latestByFileId.values()].sort(
      (a, b) => Date.parse(b.uploadedTime ?? b.modifiedTime) - Date.parse(a.uploadedTime ?? a.modifiedTime)
    );
  }

  async listHistory(fileId: string, limit = 50, cursor?: string): Promise<R2HistoryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("History page limit must be between 1 and 200.");
    }
    requiredString(fileId, "history file ID", 256);
    const query = new URLSearchParams({ fileId, limit: String(limit) });
    if (cursor !== undefined) query.set("cursor", requiredString(cursor, "history cursor", 2048));
    const response = await this.call(`history?${query.toString()}`);
    const payload = response.json as {
      historyProtocol?: unknown;
      fileId?: unknown;
      versions?: unknown;
      nextCursor?: unknown;
    } | null;
    if (
      !payload ||
      payload.historyProtocol !== 1 ||
      payload.fileId !== fileId ||
      !Array.isArray(payload.versions) ||
      payload.versions.length > limit
    ) {
      throw new Error("R2 Worker returned an invalid history page.");
    }
    if (payload.nextCursor !== null && payload.nextCursor !== undefined && typeof payload.nextCursor !== "string") {
      throw new Error("R2 Worker returned an invalid history cursor.");
    }
    if (payload.nextCursor === "") throw new Error("R2 Worker returned an invalid history cursor.");
    const versions = payload.versions.map(toHistoryVersion);
    if (versions.some((version) => version.fileId !== fileId)) {
      throw new Error("R2 Worker history crossed file identities.");
    }
    const ids = new Set<string>();
    for (const version of versions) {
      if (ids.has(version.versionId)) throw new Error("R2 Worker history contains duplicate version IDs.");
      ids.add(version.versionId);
      this.historyVersions.set(`${version.fileId}\n${version.versionId}`, version);
    }
    for (let index = 1; index < versions.length; index++) {
      if (Date.parse(versions[index - 1].sourceUploadedAt) < Date.parse(versions[index].sourceUploadedAt)) {
        throw new Error("R2 Worker history is not newest-first.");
      }
    }
    return {
      versions,
      nextCursor: payload.nextCursor ?? null,
    };
  }

  async headHistory(
    fileId: string,
    versionId: string,
    expected?: R2HistoryVersion
  ): Promise<R2HistoryVersion> {
    const query = new URLSearchParams({ fileId, versionId });
    const response = await this.call(`history/file?${query.toString()}`, { method: "HEAD" });
    return this.historyFileMetadata(response, fileId, versionId, expected);
  }

  async downloadHistory(fileId: string, versionId: string): Promise<ArrayBuffer> {
    const query = new URLSearchParams({ fileId, versionId });
    const response = await this.call(`history/file?${query.toString()}`);
    const metadata = this.historyFileMetadata(response, fileId, versionId);
    if (response.arrayBuffer.byteLength !== metadata.size) {
      throw new Error("R2 history download size did not match its metadata.");
    }
    const hash = await sha256Hex(response.arrayBuffer);
    if (hash !== metadata.sha256) throw new Error("R2 history download hash did not match its metadata.");
    return response.arrayBuffer;
  }

  private historyFileMetadata(
    response: RequestUrlResponse,
    fileId: string,
    versionId: string,
    suppliedExpected?: R2HistoryVersion
  ): R2HistoryVersion {
    requiredString(fileId, "history file ID", 256);
    requiredString(versionId, "history version ID", 256);
    const expected = suppliedExpected ?? this.historyVersions.get(`${fileId}\n${versionId}`);
    if (!expected) throw new Error("List this file's history before opening a version.");
    const size = Number(requiredString(responseHeader(response.headers, "x-owen-size"), "history size", 32));
    const mtime = Number(requiredString(responseHeader(response.headers, "x-owen-mtime"), "history mtime", 32));
    nonNegativeInteger(size, "history size");
    nonNegativeInteger(mtime, "history mtime");
    const deleted = requiredString(
      responseHeader(response.headers, "x-owen-deleted"),
      "history deletion flag",
      1
    );
    if (deleted !== "0" && deleted !== "1") {
      throw new Error("R2 Worker returned an invalid history deletion flag.");
    }
    const operationId = responseHeader(response.headers, "x-owen-operation-id");
    const lastRestoreId = responseHeader(response.headers, "x-owen-restore-id");
    const actual = {
      versionId: requiredString(responseHeader(response.headers, "x-owen-history-version-id"), "history version ID", 256),
      fileId: requiredString(responseHeader(response.headers, "x-owen-file-id"), "history file ID", 256),
      sha256: requiredString(responseHeader(response.headers, "x-owen-sha256"), "history SHA-256", 64),
      size,
      mtime,
      deviceId: requiredString(responseHeader(response.headers, "x-owen-device-id"), "history device ID", 256),
      deleted: deleted === "1",
      sourceRevision: requiredRevision(
        responseHeader(response.headers, "x-owen-source-revision"),
        "history source revision"
      ),
      sourceVersion: requiredString(
        responseHeader(response.headers, "x-owen-source-version"),
        "history source version",
        256
      ),
      sourceUploadedAt: isoTimestamp(
        responseHeader(response.headers, "x-owen-source-uploaded-at"),
        "history source upload time"
      ),
      archivedAt: isoTimestamp(
        responseHeader(response.headers, "x-owen-archived-at"),
        "history archive time"
      ),
      contentType: requiredString(responseHeader(response.headers, "content-type"), "history content type", 256),
      archiveRevision: requiredRevision(responseHeader(response.headers, "etag"), "history archive revision"),
      operationId: operationId === null
        ? undefined
        : requiredString(operationId, "history operation ID", 64),
      lastRestoreId: lastRestoreId === null
        ? undefined
        : requiredString(lastRestoreId, "history restore ID", 64),
    };
    const expectedComparable = {
      versionId: expected.versionId,
      fileId: expected.fileId,
      sha256: expected.sha256,
      size: expected.size,
      mtime: expected.mtime,
      deviceId: expected.deviceId,
      deleted: expected.deleted,
      sourceRevision: expected.sourceRevision,
      sourceVersion: expected.sourceVersion,
      sourceUploadedAt: expected.sourceUploadedAt,
      archivedAt: expected.archivedAt,
      contentType: expected.contentType,
      archiveRevision: expected.archiveRevision,
      operationId: expected.operationId,
      lastRestoreId: expected.lastRestoreId,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expectedComparable)) {
      throw new Error("R2 Worker history metadata changed or was corrupt.");
    }
    return expected;
  }

  async restoreHistory(
    version: R2HistoryVersion,
    current: Pick<R2File, "id" | "path" | "revision">,
    clientMtime = Date.now()
  ): Promise<R2File> {
    if (version.deleted) throw new Error("A deleted history marker cannot be restored.");
    if (version.fileId !== current.id) throw new Error("History restore file identity changed.");
    assertSafeRemotePath(current.path);
    if (!current.revision) throw new Error("History restore requires the current revision.");
    const operationId = crypto.randomUUID();
    const restoreId = crypto.randomUUID();
    const query = new URLSearchParams({
      fileId: current.id,
      versionId: version.versionId,
      path: current.path,
    });
    try {
      const response = await this.call(`history/restore?${query.toString()}`, {
        method: "POST",
        headers: {
          "If-Match": current.revision,
          "X-Owen-Restore-Id": restoreId,
          "X-Owen-Operation-Id": operationId,
          "X-Owen-Device-Id": this.deviceId,
          "X-Owen-Mtime": String(clientMtime),
        },
      });
      const file = this.mutationToFile(response.json as R2MutationResponse);
      this.recordLive(file);
      return file;
    } catch (error) {
      const reconciled = await this.reconcileMutation(
        current.path,
        current.id,
        version.sha256,
        false,
        operationId,
        version.size,
        clientMtime,
        this.deviceId
      );
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async download(fileId: string, expectedRevision?: string, expectedSize?: number): Promise<ArrayBuffer> {
    const path = this.requirePath(fileId);
    const response = await this.call("file", {
      path,
      headers: expectedRevision ? { "If-Match": expectedRevision } : undefined,
    });
    const revision = normalizeRevision(responseHeader(response.headers, "etag"));
    if (expectedRevision && revision !== normalizeRevision(expectedRevision)) {
      throw new Error(`${path}: R2 revision changed during download.`);
    }
    if (expectedSize !== undefined && response.arrayBuffer.byteLength !== expectedSize) {
      throw new Error(`${path}: R2 download size did not match the planned metadata.`);
    }
    return response.arrayBuffer;
  }

  async upload(
    name: string,
    parentId: string,
    content: ArrayBuffer,
    existingFileId?: string,
    expectedRevision?: string,
    knownHash?: string,
    clientMtime = Date.now()
  ): Promise<R2File> {
    const path = parentId ? `${parentId}/${name}` : name;
    assertSafeRemotePath(path);
    const tombstone = this.tombstones.get(path);
    const reusableTombstoneId = tombstone && !this.pathByFileId.has(tombstone.id)
      ? tombstone.id
      : undefined;
    const fileId = existingFileId ?? reusableTombstoneId ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const hash = knownHash ?? await sha256Hex(content);
    const condition: Record<string, string> = expectedRevision
      ? { "If-Match": expectedRevision }
      : tombstone
        ? { "If-Match": tombstone.revision }
        : { "If-None-Match": "*" };

    try {
      const commonHeaders = {
        "Content-Type": mimeType(path),
        "X-Owen-File-Id": fileId,
        "X-Owen-Sha256": hash,
        "X-Owen-Mtime": String(clientMtime),
        "X-Owen-Size": String(content.byteLength),
        "X-Owen-Device-Id": this.deviceId,
        "X-Owen-Operation-Id": operationId,
      };
      const mutation = content.byteLength >= MULTIPART_THRESHOLD
        ? await this.uploadMultipart(path, content, fileId, hash, condition, commonHeaders)
        : (await this.call("file", {
            method: "PUT",
            path,
            headers: { ...condition, ...commonHeaders },
            body: content,
          })).json as R2MutationResponse;
      const file = this.mutationToFile(mutation);
      this.recordLive(file);
      return file;
    } catch (error) {
      const reconciled = await this.reconcileMutation(
        path,
        fileId,
        hash,
        false,
        operationId,
        content.byteLength,
        clientMtime,
        this.deviceId
      );
      if (reconciled) return reconciled;
      throw error;
    }
  }

  private async uploadMultipart(
    path: string,
    content: ArrayBuffer,
    fileId: string,
    hash: string,
    condition: Record<string, string>,
    metadataHeaders: Record<string, string>
  ): Promise<R2MutationResponse> {
    const createRoute = `multipart?action=create&path=${encodeURIComponent(path)}`;
    const created = await this.call(createRoute, {
      method: "POST",
      headers: metadataHeaders,
    });
    const session = created.json as { stagingKey?: unknown; uploadId?: unknown };
    if (typeof session.stagingKey !== "string" || typeof session.uploadId !== "string") {
      throw new Error("R2 Worker returned an invalid multipart session.");
    }

    const partCount = Math.ceil(content.byteLength / MULTIPART_PART_SIZE);
    const parts = new Array<{ partNumber: number; etag: string }>(partCount);
    let nextPart = 0;
    let firstFailure: unknown = null;
    const uploadWorker = async () => {
      while (firstFailure === null) {
        const index = nextPart++;
        if (index >= partCount) return;
        const start = index * MULTIPART_PART_SIZE;
        const end = Math.min(content.byteLength, start + MULTIPART_PART_SIZE);
        const partBody = content.slice(start, end);
        try {
          const route = [
            "multipart?action=part",
            `stagingKey=${encodeURIComponent(session.stagingKey as string)}`,
            `uploadId=${encodeURIComponent(session.uploadId as string)}`,
            `partNumber=${index + 1}`,
          ].join("&");
          const response = await this.call(route, { method: "PUT", body: partBody });
          const result = response.json as { partNumber?: unknown; etag?: unknown };
          if (result.partNumber !== index + 1 || typeof result.etag !== "string") {
            throw new Error(`R2 Worker returned invalid metadata for multipart part ${index + 1}.`);
          }
          parts[index] = { partNumber: index + 1, etag: result.etag };
        } catch (error) {
          if (firstFailure === null) firstFailure = error;
        }
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(MULTIPART_CONCURRENCY, partCount) }, uploadWorker)
    );
    if (firstFailure) {
      await this.abortMultipart(session.stagingKey, session.uploadId);
      throw firstFailure instanceof Error
        ? firstFailure
        : new Error("Multipart upload failed without an Error object.");
    }

    const sessionQuery = [
      `stagingKey=${encodeURIComponent(session.stagingKey)}`,
      `uploadId=${encodeURIComponent(session.uploadId)}`,
    ].join("&");
    try {
      await this.call(`multipart?action=complete&${sessionQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
        retry: false,
      });
    } catch {
      // A completed staging object is still commit-able after the response is
      // lost. The commit below is the authoritative recovery probe.
    }

    try {
      const commitRoute = [
        "multipart?action=commit",
        `stagingKey=${encodeURIComponent(session.stagingKey)}`,
        `path=${encodeURIComponent(path)}`,
        `fileId=${encodeURIComponent(fileId)}`,
        `sha256=${hash}`,
      ].join("&");
      const committed = await this.call(commitRoute, {
        method: "POST",
        headers: { ...condition, ...metadataHeaders },
      });
      return committed.json as R2MutationResponse;
    } catch (error) {
      await this.abortMultipart(session.stagingKey, session.uploadId);
      throw error;
    }
  }

  private async abortMultipart(stagingKey: string, uploadId: string): Promise<void> {
    try {
      const route = [
        "multipart?action=abort",
        `stagingKey=${encodeURIComponent(stagingKey)}`,
        `uploadId=${encodeURIComponent(uploadId)}`,
      ].join("&");
      await this.call(route, { method: "POST", retry: false });
    } catch {
      // R2 automatically expires incomplete multipart uploads after seven days.
    }
  }

  async move(
    fileId: string,
    newName: string,
    parentId: string,
    expectedRevision?: string
  ): Promise<R2File> {
    if (!expectedRevision) throw new Error("R2 rename requires an expected revision.");
    const from = this.requirePath(fileId);
    const to = parentId ? `${parentId}/${newName}` : newName;
    assertSafeRemotePath(to);
    const operationId = crypto.randomUUID();
    try {
      const response = await this.call("move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Owen-Operation-Id": operationId,
          "X-Owen-Device-Id": this.deviceId,
        },
        body: JSON.stringify({ from, to, fileId, expectedRevision }),
      });
      const file = this.mutationToFile(response.json as R2MutationResponse);
      this.recordLive(file);
      return file;
    } catch (error) {
      // A definitive move conflict can leave a same-operation destination
      // while deliberately preserving a concurrently changed source. Do not
      // mistake that safe partial state for a completed response-loss retry.
      if (error instanceof R2HttpError && error.status < 500 && error.status !== 429) {
        throw error;
      }
      const reconciled = await this.reconcileMove(from, to, fileId, operationId);
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async trash(fileId: string, expectedRevision?: string): Promise<void> {
    if (!expectedRevision) throw new Error("R2 tombstone requires an expected revision.");
    const path = this.requirePath(fileId);
    const operationId = crypto.randomUUID();
    const clientMtime = Date.now();
    try {
      const response = await this.call("file", {
        method: "PUT",
        path,
        headers: {
          "If-Match": expectedRevision,
          "Content-Type": "application/x-owen-r2-tombstone",
          "X-Owen-Deleted": "1",
          "X-Owen-File-Id": fileId,
          "X-Owen-Sha256": EMPTY_SHA256,
          "X-Owen-Mtime": String(clientMtime),
          "X-Owen-Size": "0",
          "X-Owen-Device-Id": this.deviceId,
          "X-Owen-Operation-Id": operationId,
        },
        body: new ArrayBuffer(0),
      });
      const tombstone = this.mutationToFile(response.json as R2MutationResponse);
      this.tombstones.set(path, tombstone);
      this.pathByFileId.delete(fileId);
      this.liveFiles.delete(fileId);
    } catch (error) {
      const reconciled = await this.reconcileMutation(
        path,
        fileId,
        EMPTY_SHA256,
        true,
        operationId,
        0,
        clientMtime,
        this.deviceId
      );
      if (!reconciled) throw error;
    }
  }

  private requirePath(fileId: string): string {
    const path = this.pathByFileId.get(fileId);
    if (!path) throw new Error(`R2 file identity '${fileId}' is not in the current index.`);
    return path;
  }

  private mutationToFile(value: R2MutationResponse): R2File {
    return toFile({
      path: value.path,
      fileId: value.fileId,
      contentHash: value.sha256,
      clientMtime: value.mtime,
      contentSize: value.size,
      deviceId: this.deviceId,
      deleted: value.deleted,
      revision: value.revision,
      uploadedAt: new Date().toISOString(),
      contentType: mimeType(value.path),
    });
  }

  private recordLive(file: R2File): void {
    this.pathByFileId.set(file.id, file.path);
    this.liveFiles.set(file.id, file);
    this.tombstones.delete(file.path);
  }

  private async reconcileMove(
    from: string,
    to: string,
    fileId: string,
    operationId: string
  ): Promise<R2File | null> {
    try {
      const source = await this.call("file", { method: "HEAD", path: from, retry: false });
      if (
        responseHeader(source.headers, "x-owen-file-id") !== fileId ||
        responseHeader(source.headers, "x-owen-deleted") !== "1" ||
        responseHeader(source.headers, "x-owen-operation-id") !== operationId
      ) {
        return null;
      }
      return this.reconcileMutation(to, fileId, undefined, false, operationId);
    } catch {
      return null;
    }
  }

  private async reconcileMutation(
    path: string,
    fileId: string,
    hash: string | undefined,
    deleted: boolean,
    operationId: string,
    expectedSize?: number,
    expectedMtime?: number,
    expectedDeviceId?: string
  ): Promise<R2File | null> {
    try {
      const response = await this.call("file", { method: "HEAD", path, retry: false });
      const candidate = toFile({
        path,
        fileId: responseHeader(response.headers, "x-owen-file-id") ?? "",
        contentHash: responseHeader(response.headers, "x-owen-sha256") ?? "",
        clientMtime: Number(responseHeader(response.headers, "x-owen-mtime") ?? 0),
        contentSize: Number(responseHeader(response.headers, "x-owen-size") ?? 0),
        deviceId: responseHeader(response.headers, "x-owen-device-id") ?? this.deviceId,
        deleted: responseHeader(response.headers, "x-owen-deleted") === "1",
        revision: normalizeRevision(responseHeader(response.headers, "etag")),
        uploadedAt: new Date().toISOString(),
        contentType: responseHeader(response.headers, "content-type") ?? mimeType(path),
      });
      const candidateOperationId = responseHeader(response.headers, "x-owen-operation-id");
      const candidateSize = Number(responseHeader(response.headers, "x-owen-size"));
      const candidateMtime = Number(responseHeader(response.headers, "x-owen-mtime"));
      const candidateDeviceId = responseHeader(response.headers, "x-owen-device-id");
      if (
        candidate.id !== fileId ||
        (hash !== undefined && candidate.md5Checksum !== hash) ||
        candidate.deleted !== deleted ||
        candidateOperationId !== operationId ||
        (expectedSize !== undefined && candidateSize !== expectedSize) ||
        (expectedMtime !== undefined && candidateMtime !== expectedMtime) ||
        (expectedDeviceId !== undefined && candidateDeviceId !== expectedDeviceId)
      ) {
        return null;
      }
      if (deleted) {
        this.tombstones.set(path, candidate);
        this.pathByFileId.delete(fileId);
        this.liveFiles.delete(fileId);
      } else {
        this.recordLive(candidate);
      }
      return candidate;
    } catch {
      return null;
    }
  }
}
