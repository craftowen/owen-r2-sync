const API_PREFIX = "/v1";
const MAX_INDEX_OBJECTS = 100_000;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_SINGLE_UPLOAD_BYTES = 95 * 1024 * 1024;
const HISTORY_PROTOCOL = 1;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const MAX_HISTORY_CURSOR_BYTES = 4 * 1024;
const REVERSE_TIMESTAMP_CEILING = 9_999_999_999_999;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type SyncEnv = Env & { SYNC_TOKEN: string };

interface FileMetadata {
  path: string;
  fileId: string;
  contentHash: string;
  clientMtime: number;
  contentSize: number;
  deviceId: string;
  deleted: boolean;
  operationId?: string;
  lastRestoreId?: string;
}

interface IndexEntry extends FileMetadata {
  revision: string;
  uploadedAt: string;
  contentType: string;
}

interface MoveRequest {
  from: string;
  to: string;
  fileId: string;
  expectedRevision: string;
}

interface MultipartCompleteRequest {
  parts: Array<{ partNumber: number; etag: string }>;
}

interface HistoryMetadata extends FileMetadata {
  historySchema: 1;
  versionId: string;
  sourceRevision: string;
  sourceVersion: string;
  sourceUploadedAt: string;
  archivedAt: string;
}

interface ArchivedSnapshot {
  key: string;
  metadata: HistoryMetadata;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function objectKey(vaultId: string, path: string): string {
  const encoded = encodeURIComponent(path);
  const key = `vaults/${vaultId}/files/${encoded}`;
  if (new TextEncoder().encode(key).byteLength > 1024) {
    throw new HttpError(400, "path_too_long", "Encoded object key exceeds the R2 limit.");
  }
  return key;
}

function validateVaultId(value: string | null): string {
  if (!value || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new HttpError(400, "invalid_vault", "Vault ID must be a lowercase slug.");
  }
  return value;
}

function validatePath(value: string | null): string {
  if (!value || value.startsWith("/") || value.includes("\\") || /\p{Cc}/u.test(value)) {
    throw new HttpError(400, "invalid_path", "Path is unsafe.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "invalid_path", "Path contains an unsafe segment.");
  }
  objectKey("v", value);
  return value;
}

function validateFileId(value: string | null): string {
  if (!value || !/^[A-Za-z0-9-]{8,80}$/.test(value)) {
    throw new HttpError(400, "invalid_file_id", "File ID is invalid.");
  }
  return value;
}

function validateOperationId(value: string | null, required = false): string | undefined {
  if (!value) {
    if (required) throw new HttpError(400, "invalid_operation_id", "Operation ID is required.");
    return undefined;
  }
  if (!/^[A-Za-z0-9-]{8,80}$/.test(value)) {
    throw new HttpError(400, "invalid_operation_id", "Operation ID is invalid.");
  }
  return value;
}

function operationIdFromRequest(request: Request, required = false): string | undefined {
  return validateOperationId(request.headers.get("x-owen-operation-id"), required);
}

function restoreIdFromRequest(request: Request, required = false): string | undefined {
  return validateOperationId(request.headers.get("x-owen-restore-id"), required);
}

function validateVersionId(value: string | null): string {
  if (!value || !/^\d{13}-[a-f0-9]{64}$/.test(value)) {
    throw new HttpError(400, "invalid_version_id", "History version ID is invalid.");
  }
  return value;
}

function validateOpaqueR2Value(value: string | null, name: string): string {
  if (!value || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new HttpError(409, `invalid_history_${name}`, `History ${name} is invalid.`);
  }
  return value;
}

function validateIsoDate(value: string | null, name: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(409, `invalid_history_${name}`, `History ${name} is invalid.`);
  }
  return value;
}

function validateHash(value: string | null, deleted: boolean): string {
  const candidate = deleted && !value ? EMPTY_SHA256 : value;
  if (!candidate || !/^[a-f0-9]{64}$/.test(candidate)) {
    throw new HttpError(400, "invalid_hash", "SHA-256 must be lowercase hexadecimal.");
  }
  return candidate;
}

function finiteNonNegative(value: string | null, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be a non-negative integer.`);
  }
  return parsed;
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function validateStoredChecksum(object: R2Object, expectedHash: string): void {
  const stored = object.checksums.sha256;
  if (stored && toHex(stored) !== expectedHash) {
    throw new HttpError(409, "checksum_mismatch", "Stored SHA-256 metadata does not match the object checksum.");
  }
}

function metadataFromObject(object: R2Object): FileMetadata {
  const metadata = object.customMetadata ?? {};
  const path = validatePath(metadata.path ?? null);
  const deleted = metadata.deleted === "1";
  const parsed: FileMetadata = {
    path,
    fileId: validateFileId(metadata.fileId ?? null),
    contentHash: validateHash(metadata.contentHash ?? null, deleted),
    clientMtime: finiteNonNegative(metadata.clientMtime ?? null, "mtime"),
    contentSize: finiteNonNegative(metadata.contentSize ?? null, "size"),
    deviceId: validateFileId(metadata.deviceId ?? null),
    deleted,
  };
  const operationId = validateOperationId(metadata.operationId ?? null);
  if (operationId) parsed.operationId = operationId;
  const lastRestoreId = validateOperationId(metadata.lastRestoreId ?? null);
  if (lastRestoreId) parsed.lastRestoreId = lastRestoreId;
  return parsed;
}

function readUploadMetadata(request: Request, path: string): FileMetadata {
  const deleted = request.headers.get("x-owen-deleted") === "1";
  const metadata: FileMetadata = {
    path,
    fileId: validateFileId(request.headers.get("x-owen-file-id")),
    contentHash: validateHash(request.headers.get("x-owen-sha256"), deleted),
    clientMtime: finiteNonNegative(request.headers.get("x-owen-mtime"), "mtime"),
    contentSize: finiteNonNegative(request.headers.get("x-owen-size"), "size"),
    deviceId: validateFileId(request.headers.get("x-owen-device-id")),
    deleted,
  };
  const operationId = operationIdFromRequest(request);
  if (operationId) metadata.operationId = operationId;
  return metadata;
}

function toCustomMetadata(metadata: FileMetadata): Record<string, string> {
  return {
    path: metadata.path,
    fileId: metadata.fileId,
    contentHash: metadata.contentHash,
    clientMtime: String(metadata.clientMtime),
    contentSize: String(metadata.contentSize),
    deviceId: metadata.deviceId,
    deleted: metadata.deleted ? "1" : "0",
    ...(metadata.operationId ? { operationId: metadata.operationId } : {}),
    ...(metadata.lastRestoreId ? { lastRestoreId: metadata.lastRestoreId } : {}),
  };
}

function validateCanonicalObject(
  object: R2Object,
  vaultId: string,
  expectedPath?: string,
): FileMetadata {
  const metadata = metadataFromObject(object);
  const path = expectedPath ?? metadata.path;
  if (metadata.path !== path || object.key !== objectKey(vaultId, path)) {
    throw new HttpError(409, "metadata_mismatch", "R2 object path metadata does not match its key.");
  }
  if (object.size !== metadata.contentSize) {
    throw new HttpError(409, "size_mismatch", "Stored object size does not match its metadata.");
  }
  if (metadata.deleted && (object.size !== 0 || metadata.contentHash !== EMPTY_SHA256)) {
    throw new HttpError(409, "invalid_tombstone", "Stored tombstone metadata is inconsistent.");
  }
  validateStoredChecksum(object, metadata.contentHash);
  return metadata;
}

function conditionalHeaders(request: Request, requireCondition: boolean): Headers | undefined {
  const headers = new Headers();
  let hasCondition = false;
  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifMatch) {
    headers.set("if-match", quoteEtag(ifMatch));
    hasCondition = true;
  }
  if (ifNoneMatch) {
    headers.set("if-none-match", quoteEtag(ifNoneMatch));
    hasCondition = true;
  }
  if (requireCondition && !ifMatch && !ifNoneMatch) {
    throw new HttpError(428, "condition_required", "A conditional write header is required.");
  }
  return hasCondition ? headers : undefined;
}

function quoteEtag(value: string): string {
  if (value === "*") return value;
  const normalized = normalizeEtag(value);
  return `"${normalized}"`;
}

function normalizeEtag(value: string): string {
  const normalized = value.replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!normalized || /["\p{Cc}]/u.test(normalized)) {
    throw new HttpError(400, "invalid_revision", "Conditional revision is invalid.");
  }
  return normalized;
}

function exactIfMatch(request: Request, required = false): string | undefined {
  const value = request.headers.get("if-match");
  if (!value) {
    if (required) throw new HttpError(428, "condition_required", "An exact If-Match revision is required.");
    return undefined;
  }
  if (value.trim() === "*") {
    throw new HttpError(400, "invalid_revision", "History-preserving updates require an exact revision.");
  }
  return normalizeEtag(value);
}

async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function requireAuth(request: Request, env: SyncEnv): Promise<void> {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!env.SYNC_TOKEN || !(await verifyToken(provided, env.SYNC_TOKEN))) {
    throw new HttpError(401, "unauthorized", "Authentication failed.");
  }
}

function historyPrefix(vaultId: string, fileId: string): string {
  return `vaults/${vaultId}/history/${fileId}/`;
}

function historyKey(vaultId: string, fileId: string, versionId: string): string {
  return `${historyPrefix(vaultId, fileId)}${versionId}`;
}

async function historyVersionId(
  metadata: FileMetadata,
  sourceVersion: string,
  sourceRevision: string,
  sourceUploadedAt: string,
): Promise<string> {
  const uploadedAt = Date.parse(sourceUploadedAt);
  if (!Number.isSafeInteger(uploadedAt) || uploadedAt < 0 || uploadedAt > REVERSE_TIMESTAMP_CEILING) {
    throw new HttpError(409, "invalid_source_time", "Source upload time cannot identify a history version.");
  }
  const reverseTimestamp = String(REVERSE_TIMESTAMP_CEILING - uploadedAt).padStart(13, "0");
  const digest = await sha256Hex(JSON.stringify([
    metadata.fileId,
    metadata.path,
    sourceVersion,
    sourceRevision,
    sourceUploadedAt,
    metadata.contentHash,
    metadata.contentSize,
    metadata.clientMtime,
    metadata.deviceId,
    metadata.deleted,
    metadata.operationId ?? null,
    metadata.lastRestoreId ?? null,
  ]));
  return `${reverseTimestamp}-${digest}`;
}

function toHistoryCustomMetadata(metadata: HistoryMetadata): Record<string, string> {
  return {
    ...toCustomMetadata(metadata),
    historySchema: String(metadata.historySchema),
    versionId: metadata.versionId,
    sourceRevision: metadata.sourceRevision,
    sourceVersion: metadata.sourceVersion,
    sourceUploadedAt: metadata.sourceUploadedAt,
    archivedAt: metadata.archivedAt,
  };
}

async function historyMetadataFromObject(
  object: R2Object,
  vaultId: string,
  expectedFileId?: string,
  expectedVersionId?: string,
): Promise<HistoryMetadata> {
  const raw = object.customMetadata ?? {};
  if (raw.historySchema !== String(HISTORY_PROTOCOL)) {
    throw new HttpError(409, "invalid_history_schema", "History object schema is invalid.");
  }
  const fileMetadata = metadataFromObject(object);
  const fileId = expectedFileId ?? fileMetadata.fileId;
  const versionId = validateVersionId(expectedVersionId ?? raw.versionId ?? null);
  if (fileMetadata.fileId !== fileId || raw.versionId !== versionId) {
    throw new HttpError(409, "history_identity_mismatch", "History object identity is inconsistent.");
  }
  const metadata: HistoryMetadata = {
    ...fileMetadata,
    historySchema: HISTORY_PROTOCOL,
    versionId,
    sourceRevision: validateOpaqueR2Value(raw.sourceRevision ?? null, "revision"),
    sourceVersion: validateOpaqueR2Value(raw.sourceVersion ?? null, "source_version"),
    sourceUploadedAt: validateIsoDate(raw.sourceUploadedAt ?? null, "source_time"),
    archivedAt: validateIsoDate(raw.archivedAt ?? null, "archive_time"),
  };
  if (object.key !== historyKey(vaultId, fileId, versionId)) {
    throw new HttpError(409, "history_key_mismatch", "History object metadata does not match its key.");
  }
  if (object.size !== metadata.contentSize) {
    throw new HttpError(409, "history_size_mismatch", "History object size does not match its metadata.");
  }
  if (metadata.deleted && (object.size !== 0 || metadata.contentHash !== EMPTY_SHA256)) {
    throw new HttpError(409, "invalid_history_tombstone", "History tombstone metadata is inconsistent.");
  }
  validateStoredChecksum(object, metadata.contentHash);
  const derivedVersionId = await historyVersionId(
    metadata,
    metadata.sourceVersion,
    metadata.sourceRevision,
    metadata.sourceUploadedAt,
  );
  if (derivedVersionId !== versionId) {
    throw new HttpError(409, "history_version_mismatch", "History version ID does not match its source.");
  }
  return metadata;
}

function sameSnapshot(actual: HistoryMetadata, expected: HistoryMetadata): boolean {
  return actual.versionId === expected.versionId
    && actual.fileId === expected.fileId
    && actual.path === expected.path
    && actual.contentHash === expected.contentHash
    && actual.clientMtime === expected.clientMtime
    && actual.contentSize === expected.contentSize
    && actual.deviceId === expected.deviceId
    && actual.deleted === expected.deleted
    && actual.operationId === expected.operationId
    && actual.lastRestoreId === expected.lastRestoreId
    && actual.sourceRevision === expected.sourceRevision
    && actual.sourceVersion === expected.sourceVersion
    && actual.sourceUploadedAt === expected.sourceUploadedAt;
}

async function ensureArchived(
  env: SyncEnv,
  vaultId: string,
  path: string,
  expectedRevision: string,
  expectedFileId?: string,
  allowDeletedIdentityChange = false,
): Promise<ArchivedSnapshot> {
  const source = await env.VAULT.get(objectKey(vaultId, path), {
    onlyIf: { etagMatches: expectedRevision },
  });
  if (!source || !("body" in source)) {
    throw new HttpError(412, "precondition_failed", "Remote file changed before it could be archived.");
  }
  const sourceMetadata = validateCanonicalObject(source, vaultId, path);
  if (
    expectedFileId
    && sourceMetadata.fileId !== expectedFileId
    && !(allowDeletedIdentityChange && sourceMetadata.deleted)
  ) {
    throw new HttpError(412, "precondition_failed", "Remote file identity changed before it could be archived.");
  }
  const sourceUploadedAt = source.uploaded.toISOString();
  const versionId = await historyVersionId(
    sourceMetadata,
    source.version,
    source.etag,
    sourceUploadedAt,
  );
  const metadata: HistoryMetadata = {
    ...sourceMetadata,
    historySchema: HISTORY_PROTOCOL,
    versionId,
    sourceRevision: source.etag,
    sourceVersion: source.version,
    sourceUploadedAt,
    archivedAt: new Date().toISOString(),
  };
  const key = historyKey(vaultId, sourceMetadata.fileId, versionId);
  const archived = await env.VAULT.put(key, source.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    customMetadata: toHistoryCustomMetadata(metadata),
    httpMetadata: source.httpMetadata,
    sha256: metadata.contentHash,
  });
  const stored = archived ?? await env.VAULT.head(key);
  if (!stored) {
    throw new HttpError(500, "history_archive_failed", "History archive was not durably stored.");
  }
  const storedMetadata = await historyMetadataFromObject(stored, vaultId, metadata.fileId, versionId);
  if (!sameSnapshot(storedMetadata, metadata)) {
    throw new HttpError(409, "history_collision", "History key already contains a different snapshot.");
  }
  if ((stored.httpMetadata?.contentType ?? "application/octet-stream")
      !== (source.httpMetadata?.contentType ?? "application/octet-stream")) {
    throw new HttpError(409, "history_metadata_mismatch", "History content type does not match its source.");
  }
  return { key, metadata: storedMetadata };
}

function mutationResult(object: R2Object, metadata: FileMetadata): Response {
  return json({
    path: metadata.path,
    fileId: metadata.fileId,
    revision: object.etag,
    sha256: metadata.contentHash,
    size: metadata.contentSize,
    mtime: metadata.clientMtime,
    deleted: metadata.deleted,
    ...(metadata.operationId ? { operationId: metadata.operationId } : {}),
    ...(metadata.lastRestoreId ? { lastRestoreId: metadata.lastRestoreId } : {}),
  });
}

function withOperation(metadata: FileMetadata, operationId?: string): FileMetadata {
  const next = { ...metadata };
  if (operationId) next.operationId = operationId;
  else delete next.operationId;
  delete next.lastRestoreId;
  return next;
}

async function reconcileOperation(
  env: SyncEnv,
  vaultId: string,
  desired: FileMetadata,
  expectedContentType: string,
): Promise<R2Object | null> {
  if (!desired.operationId) return null;
  const current = await env.VAULT.head(objectKey(vaultId, desired.path));
  if (!current) return null;
  const metadata = validateCanonicalObject(current, vaultId, desired.path);
  if (metadata.operationId !== desired.operationId) return null;
  const matches = metadata.fileId === desired.fileId
    && metadata.contentHash === desired.contentHash
    && metadata.contentSize === desired.contentSize
    && metadata.clientMtime === desired.clientMtime
    && metadata.deviceId === desired.deviceId
    && metadata.deleted === desired.deleted
    && metadata.lastRestoreId === desired.lastRestoreId
    && (current.httpMetadata?.contentType ?? "application/octet-stream") === expectedContentType;
  if (!matches) {
    throw new HttpError(409, "operation_id_reused", "Operation ID was already committed with different metadata.");
  }
  return current;
}

async function listIndex(env: SyncEnv, vaultId: string): Promise<IndexEntry[]> {
  const prefix = `vaults/${vaultId}/files/`;
  const entries: IndexEntry[] = [];
  let cursor: string | undefined;

  do {
    const listed = await env.VAULT.list({
      prefix,
      cursor,
      limit: 1000,
      include: ["httpMetadata", "customMetadata"],
    });
    for (const object of listed.objects) {
      if (entries.length >= MAX_INDEX_OBJECTS) {
        throw new HttpError(413, "index_too_large", "Vault index exceeds the safety limit.");
      }
      const metadata = validateCanonicalObject(object, vaultId);
      entries.push({
        ...metadata,
        revision: object.etag,
        uploadedAt: object.uploaded.toISOString(),
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function assertRestoreIdentityAvailable(
  env: SyncEnv,
  vaultId: string,
  targetPath: string,
  fileId: string,
  expectedRevision: string,
): Promise<void> {
  const target = await env.VAULT.head(objectKey(vaultId, targetPath));
  if (!target || target.etag !== expectedRevision) {
    throw new HttpError(412, "precondition_failed", "Remote file changed before restore identity validation.");
  }
  const targetMetadata = validateCanonicalObject(target, vaultId, targetPath);
  if (targetMetadata.fileId !== fileId) {
    throw new HttpError(412, "precondition_failed", "Remote file identity changed before restore.");
  }

  const prefix = `vaults/${vaultId}/files/`;
  let scanned = 0;
  let cursor: string | undefined;

  do {
    const listed = await env.VAULT.list({
      prefix,
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    });
    for (const object of listed.objects) {
      if (scanned >= MAX_INDEX_OBJECTS) {
        throw new HttpError(413, "restore_scan_too_large", "Vault identity scan exceeds the safety limit.");
      }
      scanned += 1;
      const metadata = validateCanonicalObject(object, vaultId);
      if (metadata.path !== targetPath && !metadata.deleted && metadata.fileId === fileId) {
        throw new HttpError(
          409,
          "duplicate_live_file_id",
          "Another live canonical object already uses this file ID.",
        );
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function objectHeaders(object: R2Object, metadata: FileMetadata): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    etag: object.httpEtag,
    "x-owen-file-id": metadata.fileId,
    "x-owen-sha256": metadata.contentHash,
    "x-owen-mtime": String(metadata.clientMtime),
    "x-owen-size": String(metadata.contentSize),
    "x-owen-device-id": metadata.deviceId,
    "x-owen-deleted": metadata.deleted ? "1" : "0",
    "x-content-type-options": "nosniff",
  });
  if (metadata.operationId) headers.set("x-owen-operation-id", metadata.operationId);
  if (metadata.lastRestoreId) headers.set("x-owen-restore-id", metadata.lastRestoreId);
  object.writeHttpMetadata(headers);
  return headers;
}

function historyHeaders(object: R2Object, metadata: HistoryMetadata): Headers {
  const headers = objectHeaders(object, metadata);
  headers.set("x-owen-history-version-id", metadata.versionId);
  headers.set("x-owen-source-revision", metadata.sourceRevision);
  headers.set("x-owen-source-version", metadata.sourceVersion);
  headers.set("x-owen-source-uploaded-at", metadata.sourceUploadedAt);
  headers.set("x-owen-archived-at", metadata.archivedAt);
  return headers;
}

function historyEntry(object: R2Object, metadata: HistoryMetadata): Record<string, unknown> {
  return {
    versionId: metadata.versionId,
    fileId: metadata.fileId,
    path: metadata.path,
    sha256: metadata.contentHash,
    size: metadata.contentSize,
    mtime: metadata.clientMtime,
    deviceId: metadata.deviceId,
    deleted: metadata.deleted,
    sourceRevision: metadata.sourceRevision,
    sourceVersion: metadata.sourceVersion,
    sourceUploadedAt: metadata.sourceUploadedAt,
    archivedAt: metadata.archivedAt,
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    archiveRevision: object.etag,
    ...(metadata.operationId ? { operationId: metadata.operationId } : {}),
    ...(metadata.lastRestoreId ? { lastRestoreId: metadata.lastRestoreId } : {}),
  };
}

function historyLimit(value: string | null): number {
  if (value === null) return DEFAULT_HISTORY_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_LIMIT) {
    throw new HttpError(400, "invalid_limit", `History limit must be between 1 and ${MAX_HISTORY_LIMIT}.`);
  }
  return parsed;
}

function historyCursor(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (
    value.length === 0
    || new TextEncoder().encode(value).byteLength > MAX_HISTORY_CURSOR_BYTES
    || /\p{Cc}/u.test(value)
  ) {
    throw new HttpError(400, "invalid_cursor", "History cursor is invalid.");
  }
  return value;
}

async function listHistory(env: SyncEnv, vaultId: string, url: URL): Promise<Response> {
  const fileId = validateFileId(url.searchParams.get("fileId"));
  const limit = historyLimit(url.searchParams.get("limit"));
  const cursor = historyCursor(url.searchParams.get("cursor"));
  const listed = await env.VAULT.list({
    prefix: historyPrefix(vaultId, fileId),
    limit,
    cursor,
    include: ["httpMetadata", "customMetadata"],
  });
  const versions = await Promise.all(listed.objects.map(async (object) => {
    const metadata = await historyMetadataFromObject(object, vaultId, fileId);
    return historyEntry(object, metadata);
  }));
  return json({
    historyProtocol: HISTORY_PROTOCOL,
    fileId,
    versions,
    nextCursor: listed.truncated ? listed.cursor : null,
  });
}

async function getHistoryFile(
  env: SyncEnv,
  request: Request,
  vaultId: string,
  url: URL,
): Promise<Response> {
  const fileId = validateFileId(url.searchParams.get("fileId"));
  const versionId = validateVersionId(url.searchParams.get("versionId"));
  const object = await env.VAULT.get(historyKey(vaultId, fileId, versionId));
  if (!object) throw new HttpError(404, "history_not_found", "History version does not exist.");
  const metadata = await historyMetadataFromObject(object, vaultId, fileId, versionId);
  if (metadata.deleted) {
    throw new HttpError(410, "history_tombstone", "Deleted history markers do not contain restorable content.");
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: historyHeaders(object, metadata),
  });
}

async function restoreHistory(
  env: SyncEnv,
  request: Request,
  vaultId: string,
  url: URL,
): Promise<Response> {
  const fileId = validateFileId(url.searchParams.get("fileId"));
  const versionId = validateVersionId(url.searchParams.get("versionId"));
  const path = validatePath(url.searchParams.get("path"));
  const expectedRevision = exactIfMatch(request, true) as string;
  const operationId = operationIdFromRequest(request, true) as string;
  const restoreId = restoreIdFromRequest(request, true) as string;
  const clientMtime = finiteNonNegative(request.headers.get("x-owen-mtime"), "mtime");
  const deviceId = validateFileId(request.headers.get("x-owen-device-id"));
  const archiveKey = historyKey(vaultId, fileId, versionId);
  const archivedHead = await env.VAULT.head(archiveKey);
  if (!archivedHead) throw new HttpError(404, "history_not_found", "History version does not exist.");
  const archivedMetadata = await historyMetadataFromObject(archivedHead, vaultId, fileId, versionId);
  if (archivedMetadata.deleted) {
    throw new HttpError(410, "history_tombstone", "Deleted history markers cannot be restored.");
  }
  const contentType = archivedHead.httpMetadata?.contentType ?? "application/octet-stream";
  const desired: FileMetadata = {
    path,
    fileId,
    contentHash: archivedMetadata.contentHash,
    contentSize: archivedMetadata.contentSize,
    clientMtime,
    deviceId,
    deleted: false,
    operationId,
    lastRestoreId: restoreId,
  };
  const replay = await reconcileOperation(env, vaultId, desired, contentType);
  if (replay) return mutationResult(replay, desired);

  await assertRestoreIdentityAvailable(env, vaultId, path, fileId, expectedRevision);
  await ensureArchived(env, vaultId, path, expectedRevision, fileId);
  const archived = await env.VAULT.get(archiveKey, {
    onlyIf: { etagMatches: archivedHead.etag },
  });
  if (!archived || !("body" in archived)) {
    throw new HttpError(409, "history_changed", "History version changed before restore.");
  }
  const verifiedMetadata = await historyMetadataFromObject(archived, vaultId, fileId, versionId);
  if (!sameSnapshot(verifiedMetadata, archivedMetadata)) {
    throw new HttpError(409, "history_changed", "History version changed before restore.");
  }
  const restored = await env.VAULT.put(objectKey(vaultId, path), archived.body, {
    onlyIf: { etagMatches: expectedRevision },
    customMetadata: toCustomMetadata(desired),
    httpMetadata: archived.httpMetadata,
    sha256: desired.contentHash,
  });
  if (!restored) throw new HttpError(412, "precondition_failed", "Remote file changed during restore.");
  if (restored.size !== desired.contentSize) {
    throw new HttpError(422, "size_mismatch", "Restored object size does not match history metadata.");
  }
  return mutationResult(restored, desired);
}

async function getObject(env: SyncEnv, request: Request, vaultId: string, path: string): Promise<Response> {
  const condition = conditionalHeaders(request, false);
  const object = await env.VAULT.get(objectKey(vaultId, path), condition ? { onlyIf: condition } : undefined);
  if (!object) throw new HttpError(404, "not_found", "File does not exist.");
  if (!("body" in object)) throw new HttpError(412, "precondition_failed", "Remote file changed.");
  const metadata = validateCanonicalObject(object, vaultId, path);
  if (metadata.deleted && request.method !== "HEAD") {
    throw new HttpError(410, "deleted", "File is deleted.");
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: objectHeaders(object, metadata),
  });
}

async function putObject(env: SyncEnv, request: Request, vaultId: string, path: string): Promise<Response> {
  const metadata = readUploadMetadata(request, path);
  const contentType = metadata.deleted
    ? "application/x-owen-r2-tombstone"
    : request.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = Number(request.headers.get("content-length") ?? metadata.contentSize);
  if (!Number.isFinite(contentLength) || contentLength !== metadata.contentSize) {
    throw new HttpError(400, "size_mismatch", "Content-Length does not match declared size.");
  }
  if (!metadata.deleted && contentLength > MAX_SINGLE_UPLOAD_BYTES) {
    throw new HttpError(413, "multipart_required", "Files over 95 MiB must use multipart upload.");
  }
  if (metadata.deleted && metadata.contentSize !== 0) {
    throw new HttpError(400, "invalid_tombstone", "Tombstones must have zero content size.");
  }
  if (!request.body && !metadata.deleted) {
    throw new HttpError(400, "missing_body", "File body is required.");
  }

  const replay = await reconcileOperation(env, vaultId, metadata, contentType);
  if (replay) return mutationResult(replay, metadata);

  const expectedRevision = exactIfMatch(request);
  if (!expectedRevision && request.headers.get("if-none-match")?.trim() !== "*") {
    throw new HttpError(428, "condition_required", "Create requires If-None-Match: * or an exact If-Match revision.");
  }
  const condition = conditionalHeaders(request, true);
  if (expectedRevision) {
    await ensureArchived(env, vaultId, path, expectedRevision, metadata.fileId, true);
  }
  const object = await env.VAULT.put(
    objectKey(vaultId, path),
    metadata.deleted ? new Uint8Array() : request.body,
    {
      onlyIf: condition,
      customMetadata: toCustomMetadata(metadata),
      httpMetadata: { contentType },
      sha256: metadata.deleted ? EMPTY_SHA256 : metadata.contentHash,
    },
  );
  if (!object) throw new HttpError(412, "precondition_failed", "Remote file changed.");
  if (object.size !== metadata.contentSize) {
    throw new HttpError(422, "size_mismatch", "Stored object size does not match declared size.");
  }
  return mutationResult(object, metadata);
}

async function parseMoveRequest(request: Request): Promise<MoveRequest> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BODY_BYTES) throw new HttpError(413, "body_too_large", "Move request is too large.");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object") throw new HttpError(400, "invalid_move", "Move payload is invalid.");
  const candidate = value as Partial<MoveRequest>;
  return {
    from: validatePath(typeof candidate.from === "string" ? candidate.from : null),
    to: validatePath(typeof candidate.to === "string" ? candidate.to : null),
    fileId: validateFileId(typeof candidate.fileId === "string" ? candidate.fileId : null),
    expectedRevision: typeof candidate.expectedRevision === "string" && candidate.expectedRevision
      ? candidate.expectedRevision
      : (() => { throw new HttpError(400, "invalid_revision", "Expected revision is required."); })(),
  };
}

async function moveObject(env: SyncEnv, request: Request, vaultId: string): Promise<Response> {
  const move = await parseMoveRequest(request);
  const operationId = operationIdFromRequest(request);
  if (move.from === move.to) throw new HttpError(400, "same_path", "Move source and destination are identical.");
  const sourceKey = objectKey(vaultId, move.from);
  const destinationKey = objectKey(vaultId, move.to);

  const existingDestination = await env.VAULT.head(destinationKey);
  if (existingDestination) {
    const destinationMetadata = validateCanonicalObject(existingDestination, vaultId, move.to);
    if (!destinationMetadata.deleted && destinationMetadata.fileId === move.fileId) {
      const currentSource = await env.VAULT.head(sourceKey);
      if (currentSource) {
        const sourceMetadata = validateCanonicalObject(currentSource, vaultId, move.from);
        const operationMatches = !operationId || destinationMetadata.operationId === operationId;
        if (sourceMetadata.deleted && sourceMetadata.fileId === move.fileId && operationMatches) {
          return mutationResult(existingDestination, destinationMetadata);
        }
        const canResume = !sourceMetadata.deleted
          && sourceMetadata.fileId === move.fileId
          && currentSource.etag === normalizeEtag(move.expectedRevision)
          && destinationMetadata.contentHash === sourceMetadata.contentHash
          && destinationMetadata.contentSize === sourceMetadata.contentSize
          && operationMatches;
        if (canResume) {
          await ensureArchived(env, vaultId, move.from, currentSource.etag, move.fileId);
          const tombstoneMetadata = withOperation({
            ...sourceMetadata,
            path: move.from,
            contentHash: EMPTY_SHA256,
            contentSize: 0,
            deleted: true,
          }, operationId);
          const tombstone = await env.VAULT.put(sourceKey, new Uint8Array(), {
            onlyIf: { etagMatches: currentSource.etag },
            customMetadata: toCustomMetadata(tombstoneMetadata),
            httpMetadata: { contentType: "application/x-owen-r2-tombstone" },
            sha256: EMPTY_SHA256,
          });
          if (!tombstone) {
            throw new HttpError(409, "source_changed_after_copy", "Move preserved both paths because the source changed concurrently.");
          }
          return mutationResult(existingDestination, destinationMetadata);
        }
      }
    }
    throw new HttpError(412, "destination_exists", "Move destination already exists.");
  }

  const expectedRevision = normalizeEtag(move.expectedRevision);
  await ensureArchived(env, vaultId, move.from, expectedRevision, move.fileId);
  const source = await env.VAULT.get(sourceKey, { onlyIf: { etagMatches: expectedRevision } });
  if (!source) throw new HttpError(404, "not_found", "Move source does not exist.");
  if (!("body" in source)) throw new HttpError(412, "precondition_failed", "Move source changed.");
  const sourceMetadata = validateCanonicalObject(source, vaultId, move.from);
  if (sourceMetadata.deleted || sourceMetadata.fileId !== move.fileId) {
    throw new HttpError(412, "precondition_failed", "Move source identity changed.");
  }

  const destinationMetadata = withOperation({ ...sourceMetadata, path: move.to }, operationId);
  const destination = await env.VAULT.put(destinationKey, source.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    customMetadata: toCustomMetadata(destinationMetadata),
    httpMetadata: source.httpMetadata,
    sha256: sourceMetadata.contentHash,
  });
  if (!destination) throw new HttpError(412, "destination_exists", "Move destination appeared concurrently.");

  const tombstoneMetadata = withOperation({
    ...sourceMetadata,
    path: move.from,
    contentHash: EMPTY_SHA256,
    contentSize: 0,
    deleted: true,
  }, operationId);
  const tombstone = await env.VAULT.put(sourceKey, new Uint8Array(), {
    onlyIf: { etagMatches: source.etag },
    customMetadata: toCustomMetadata(tombstoneMetadata),
    httpMetadata: { contentType: "application/x-owen-r2-tombstone" },
    sha256: EMPTY_SHA256,
  });
  if (!tombstone) {
    throw new HttpError(409, "source_changed_after_copy", "Move preserved both paths because the source changed concurrently.");
  }

  return mutationResult(destination, destinationMetadata);
}

function validateStagingKey(vaultId: string, value: string | null): string {
  const prefix = `vaults/${vaultId}/staging/`;
  if (!value || !value.startsWith(prefix) || value.includes("..") || /\p{Cc}/u.test(value)) {
    throw new HttpError(400, "invalid_staging_key", "Multipart staging key is invalid.");
  }
  return value;
}

async function multipartObject(env: SyncEnv, request: Request, vaultId: string, url: URL): Promise<Response> {
  const action = url.searchParams.get("action");
  if (action === "create" && request.method === "POST") {
    const path = validatePath(url.searchParams.get("path"));
    const metadata = readUploadMetadata(request, path);
    if (metadata.deleted) throw new HttpError(400, "invalid_multipart", "Tombstones do not use multipart upload.");
    const stagingKey = `vaults/${vaultId}/staging/${metadata.fileId}/${crypto.randomUUID()}`;
    const upload = await env.VAULT.createMultipartUpload(stagingKey, {
      customMetadata: toCustomMetadata(metadata),
      httpMetadata: {
        contentType: request.headers.get("content-type") ?? "application/octet-stream",
      },
    });
    return json({ stagingKey, uploadId: upload.uploadId });
  }

  const stagingKey = validateStagingKey(vaultId, url.searchParams.get("stagingKey"));
  const uploadId = url.searchParams.get("uploadId");
  if (action === "part" && request.method === "PUT") {
    if (!uploadId || !request.body) throw new HttpError(400, "invalid_part", "Upload ID and part body are required.");
    const partNumber = finiteNonNegative(url.searchParams.get("partNumber"), "part_number");
    if (partNumber < 1 || partNumber > 10_000) throw new HttpError(400, "invalid_part", "Part number is out of range.");
    const part = await env.VAULT.resumeMultipartUpload(stagingKey, uploadId).uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  if (action === "complete" && request.method === "POST") {
    if (!uploadId) throw new HttpError(400, "invalid_upload", "Upload ID is required.");
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 1024 * 1024) throw new HttpError(413, "body_too_large", "Multipart completion body is too large.");
    const payload = await request.json<MultipartCompleteRequest>();
    if (!Array.isArray(payload.parts) || payload.parts.length < 1 || payload.parts.length > 10_000) {
      throw new HttpError(400, "invalid_parts", "Multipart completion parts are invalid.");
    }
    const seenPartNumbers = new Set<number>();
    const parts = payload.parts.map((part) => {
      const partNumber = finiteNonNegative(String(part.partNumber), "part_number");
      if (partNumber < 1 || partNumber > 10_000 || seenPartNumbers.has(partNumber)) {
        throw new HttpError(400, "invalid_part", "Part numbers must be unique and between 1 and 10,000.");
      }
      seenPartNumbers.add(partNumber);
      return {
        partNumber,
        etag: typeof part.etag === "string" && part.etag ? part.etag : (() => {
          throw new HttpError(400, "invalid_part", "Part ETag is required.");
        })(),
      };
    }).sort((a, b) => a.partNumber - b.partNumber);
    const object = await env.VAULT.resumeMultipartUpload(stagingKey, uploadId).complete(parts);
    return json({ stagingKey, revision: object.etag, size: object.size });
  }

  if (action === "abort" && request.method === "POST") {
    if (!uploadId) throw new HttpError(400, "invalid_upload", "Upload ID is required.");
    try {
      await env.VAULT.resumeMultipartUpload(stagingKey, uploadId).abort();
    } catch {
      // The upload may already have completed into a staging object.
    }
    await env.VAULT.delete(stagingKey);
    return json({ aborted: true });
  }

  if (action === "commit" && request.method === "POST") {
    const path = validatePath(url.searchParams.get("path"));
    const expectedFileId = validateFileId(url.searchParams.get("fileId"));
    const expectedHash = validateHash(url.searchParams.get("sha256"), false);
    const requestOperationId = operationIdFromRequest(request);
    const canonicalKey = objectKey(vaultId, path);
    const stagedHead = await env.VAULT.head(stagingKey);
    if (!stagedHead) {
      const existing = await env.VAULT.head(canonicalKey);
      if (existing) {
        const metadata = validateCanonicalObject(existing, vaultId, path);
        if (
          metadata.fileId === expectedFileId
          && metadata.contentHash === expectedHash
          && !metadata.deleted
          && (!requestOperationId || metadata.operationId === requestOperationId)
        ) {
          return mutationResult(existing, metadata);
        }
      }
      throw new HttpError(404, "staging_missing", "Completed multipart staging object is missing.");
    }
    const stagedMetadata = metadataFromObject(stagedHead);
    if (
      stagedMetadata.path !== path ||
      stagedMetadata.fileId !== expectedFileId ||
      stagedMetadata.contentHash !== expectedHash ||
      stagedMetadata.deleted ||
      stagedHead.size !== stagedMetadata.contentSize
    ) {
      throw new HttpError(422, "staging_mismatch", "Multipart staging metadata does not match its content.");
    }
    validateStoredChecksum(stagedHead, stagedMetadata.contentHash);
    if (requestOperationId && stagedMetadata.operationId && requestOperationId !== stagedMetadata.operationId) {
      throw new HttpError(409, "operation_id_mismatch", "Multipart operation ID changed before commit.");
    }
    const metadata = withOperation(stagedMetadata, requestOperationId ?? stagedMetadata.operationId);
    const contentType = stagedHead.httpMetadata?.contentType ?? "application/octet-stream";
    const replay = await reconcileOperation(env, vaultId, metadata, contentType);
    if (replay) {
      await env.VAULT.delete(stagingKey);
      return mutationResult(replay, metadata);
    }
    const expectedRevision = exactIfMatch(request);
    if (!expectedRevision && request.headers.get("if-none-match")?.trim() !== "*") {
      throw new HttpError(428, "condition_required", "Multipart create requires If-None-Match: * or an exact If-Match revision.");
    }
    const condition = conditionalHeaders(request, true);
    if (expectedRevision) {
      await ensureArchived(env, vaultId, path, expectedRevision, metadata.fileId, true);
    }
    const staged = await env.VAULT.get(stagingKey, { onlyIf: { etagMatches: stagedHead.etag } });
    if (!staged || !("body" in staged)) {
      throw new HttpError(409, "staging_changed", "Multipart staging object changed before commit.");
    }
    const committed = await env.VAULT.put(canonicalKey, staged.body, {
      onlyIf: condition,
      customMetadata: toCustomMetadata(metadata),
      httpMetadata: staged.httpMetadata,
      sha256: metadata.contentHash,
    });
    if (!committed) {
      throw new HttpError(412, "precondition_failed", "Remote file changed.");
    }
    await env.VAULT.delete(stagingKey);
    return mutationResult(committed, metadata);
  }

  throw new HttpError(404, "not_found", "Multipart route does not exist.");
}

async function route(request: Request, env: SyncEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,HEAD,PUT,POST,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,if-match,if-none-match,x-owen-file-id,x-owen-sha256,x-owen-mtime,x-owen-size,x-owen-device-id,x-owen-deleted,x-owen-operation-id,x-owen-restore-id",
        "access-control-max-age": "86400",
      },
    });
  }
  await requireAuth(request, env);

  const url = new URL(request.url);
  if (!url.pathname.startsWith(API_PREFIX)) throw new HttpError(404, "not_found", "Route does not exist.");
  const vaultId = validateVaultId(url.searchParams.get("vault"));

  if (url.pathname === `${API_PREFIX}/health` && request.method === "GET") {
    const listed = await env.VAULT.list({ prefix: `vaults/${vaultId}/files/`, limit: 1 });
    return json({ ok: true, vaultId, hasFiles: listed.objects.length > 0, historyProtocol: HISTORY_PROTOCOL });
  }
  if (url.pathname === `${API_PREFIX}/index` && request.method === "GET") {
    return json({ vaultId, entries: await listIndex(env, vaultId) });
  }
  if (url.pathname === `${API_PREFIX}/history` && request.method === "GET") {
    return listHistory(env, vaultId, url);
  }
  if (
    url.pathname === `${API_PREFIX}/history/file`
    && (request.method === "GET" || request.method === "HEAD")
  ) {
    return getHistoryFile(env, request, vaultId, url);
  }
  if (url.pathname === `${API_PREFIX}/history/restore` && request.method === "POST") {
    return restoreHistory(env, request, vaultId, url);
  }
  if (url.pathname === `${API_PREFIX}/file`) {
    const path = validatePath(url.searchParams.get("path"));
    if (request.method === "GET" || request.method === "HEAD") {
      return getObject(env, request, vaultId, path);
    }
    if (request.method === "PUT") return putObject(env, request, vaultId, path);
  }
  if (url.pathname === `${API_PREFIX}/move` && request.method === "POST") {
    return moveObject(env, request, vaultId);
  }
  if (url.pathname === `${API_PREFIX}/multipart`) {
    return multipartObject(env, request, vaultId, url);
  }
  throw new HttpError(404, "not_found", "Route does not exist.");
}

export default {
  async fetch(request: Request, env: SyncEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await route(request, env);
      response.headers.set("access-control-allow-origin", "*");
      response.headers.set("x-request-id", requestId);
      console.log(JSON.stringify({
        message: "request complete",
        requestId,
        method: request.method,
        route: new URL(request.url).pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      }));
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      const message = error instanceof HttpError ? error.message : "Internal server error.";
      console.error(JSON.stringify({
        message: "request failed",
        requestId,
        method: request.method,
        route: new URL(request.url).pathname,
        status,
        code,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: code, message, requestId }, status, {
        "access-control-allow-origin": "*",
        "x-request-id": requestId,
      });
    }
  },
} satisfies ExportedHandler<SyncEnv>;
