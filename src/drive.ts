// Minimal Google Drive v3 client over Obsidian's requestUrl (no CORS pain).
// Scope drive.file: the plugin only ever sees files and folders it created,
// which is exactly the vault mirror and nothing else in anyone's Drive.

import { type RequestUrlResponse, requestUrl } from "obsidian";
import { assertSafeRemotePath } from "./safety";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Swappable for tests: a local mock server can stand in for Google.
export interface DriveEndpoints {
  api: string;
  upload: string;
  token: string;
  revoke: string;
}

const DEFAULT_ENDPOINTS: DriveEndpoints = {
  api: API,
  upload: UPLOAD,
  token: TOKEN_URL,
  revoke: REVOKE_URL,
};

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export interface DriveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
}

interface CallOptions {
  method?: string;
  body?: string | ArrayBuffer;
  contentType?: string;
  retry?: "safe" | "none";
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class DriveClient {
  private ep: DriveEndpoints;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private tokens: DriveTokens,
    private onTokens: (t: DriveTokens) => void,
    endpoints?: Partial<DriveEndpoints>
  ) {
    this.ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
  }

  static async exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
    codeVerifier: string,
    tokenUrl = TOKEN_URL
  ): Promise<DriveTokens> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString();
    const res = await requestUrl({
      url: tokenUrl,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body,
    });
    const j = res.json as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!j.refresh_token) {
      throw new Error(
        "Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and connect again."
      );
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + (j.expires_in - 60) * 1000,
    };
  }

  static async revokeToken(refreshToken: string, revokeUrl = REVOKE_URL): Promise<void> {
    const res = await requestUrl({
      url: revokeUrl,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ token: refreshToken }).toString(),
      throw: false,
    });
    if (res.status >= 300 && res.status !== 400) {
      throw new Error(`Google token revocation failed (${res.status}).`);
    }
  }

  private async token(force = false): Promise<string> {
    if (!force && Date.now() < this.tokens.expiresAt) return this.tokens.accessToken;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refreshToken,
      grant_type: "refresh_token",
    }).toString();
    const res = await requestUrl({
      url: this.ep.token,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body,
      throw: false,
    });
    if (res.status >= 300) {
      throw new Error(
        res.status === 400
          ? "Google authorization expired. Disconnect and reconnect this device."
          : `Google token refresh failed (${res.status}).`
      );
    }
    const j = res.json as { access_token: string; expires_in: number };
    this.tokens = {
      ...this.tokens,
      accessToken: j.access_token,
      expiresAt: Date.now() + (j.expires_in - 60) * 1000,
    };
    this.onTokens(this.tokens);
    return this.tokens.accessToken;
  }

  // Rate limits and transient server errors retry with exponential backoff
  // instead of failing the whole sync over one hiccup.
  private async call(url: string, init: CallOptions = {}) {
    let lastErr: unknown = null;
    let refreshedAfter401 = false;
    const retry = init.retry ?? (init.method === "POST" ? "none" : "safe");
    const attempts = retry === "safe" ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** attempt);
      const t = await this.token();
      let res: RequestUrlResponse;
      try {
        res = await requestUrl({
          url,
          method: init.method ?? "GET",
          headers: { Authorization: `Bearer ${t}` },
          contentType: init.contentType,
          body: init.body,
          throw: false,
        });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status < 300) return res;
      if (res.status === 401 && !refreshedAfter401) {
        await this.token(true);
        refreshedAfter401 = true;
        attempt--;
        continue;
      }
      const reason = (
        res.json as { error?: { errors?: Array<{ reason?: string }> } } | null
      )?.error?.errors?.[0]?.reason;
      const transient403 =
        res.status === 403 &&
        ["backendError", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason ?? "");
      if (retry === "safe" && (res.status === 429 || res.status >= 500 || transient403)) {
        lastErr = new Error(`Drive returned ${res.status}${reason ? ` (${reason})` : ""}`);
        continue;
      }
      throw new Error(`Drive returned ${res.status} for ${url.split("?")[0]}`);
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Drive request failed after retries.");
  }

  private async findChildren(
    name: string,
    parentId: string,
    folder: boolean
  ): Promise<DriveFile[]> {
    const mime = folder
      ? " and mimeType = 'application/vnd.google-apps.folder'"
      : " and mimeType != 'application/vnd.google-apps.folder'";
    const q = encodeURIComponent(
      `name = '${escapeQueryValue(name)}'${mime} and '${escapeQueryValue(parentId)}' in parents and trashed = false`
    );
    const found = await this.call(
      `${this.ep.api}/files?q=${q}&fields=files(id,name,mimeType,md5Checksum,size,modifiedTime,parents,trashed)`
    );
    return (found.json as { files?: DriveFile[] }).files ?? [];
  }

  private unique(files: DriveFile[], description: string): DriveFile | null {
    if (files.length > 1) {
      throw new Error(`Drive contains duplicate ${description}; resolve the duplicates before syncing.`);
    }
    return files[0] ?? null;
  }

  async findFolder(name: string, parentId = "root"): Promise<string | null> {
    return this.unique(await this.findChildren(name, parentId, true), `folder '${name}'`)?.id ?? null;
  }

  async ensureFolder(name: string, parentId?: string): Promise<string> {
    const parent = parentId ?? "root";
    const existing = await this.findFolder(name, parent);
    if (existing) return existing;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const created = await this.call(`${this.ep.api}/files?fields=id`, {
          method: "POST",
          retry: "none",
          contentType: "application/json",
          body: JSON.stringify({
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [parent],
          }),
        });
        return (created.json as { id: string }).id;
      } catch (error) {
        lastError = error;
        const recovered = await this.findFolder(name, parent);
        if (recovered) return recovered;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Drive folder creation failed.");
  }

  async verifyFolder(folderId: string): Promise<void> {
    const folder = await this.metadata(folderId);
    if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("The configured Drive sync folder is missing or in Drive Trash.");
    }
  }

  async metadata(fileId: string): Promise<DriveFile> {
    const fields = "id,name,mimeType,md5Checksum,size,modifiedTime,parents,trashed";
    const res = await this.call(
      `${this.ep.api}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`
    );
    return res.json as DriveFile;
  }

  private revision(file: DriveFile): string {
    return file.md5Checksum ?? file.modifiedTime ?? "";
  }

  private async assertRevision(fileId: string, expectedRevision?: string): Promise<void> {
    if (!expectedRevision) return;
    const current = await this.metadata(fileId);
    if (this.revision(current) !== expectedRevision) {
      throw new Error("Drive file changed after planning. Preview and sync again.");
    }
  }

  // List every descendant of the root folder, returning vault-relative paths.
  async listTree(rootId: string): Promise<Map<string, DriveFile & { path: string }>> {
    const out = new Map<string, DriveFile & { path: string }>();
    const visited = new Set<string>();
    const walk = async (folderId: string, prefix: string, depth: number) => {
      if (depth > 64) throw new Error("Drive folder nesting exceeds the safety limit.");
      if (visited.has(folderId)) throw new Error("Drive folder graph contains a cycle.");
      visited.add(folderId);
      let pageToken = "";
      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const fields = encodeURIComponent(
          "nextPageToken, files(id,name,mimeType,md5Checksum,size,modifiedTime)"
        );
        const res = await this.call(
          `${this.ep.api}/files?q=${q}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`
        );
        const j = res.json as { files: DriveFile[]; nextPageToken?: string };
        for (const f of j.files) {
          const path = prefix ? `${prefix}/${f.name}` : f.name;
          assertSafeRemotePath(path);
          if (f.mimeType === "application/vnd.google-apps.folder") {
            await walk(f.id, path, depth + 1);
          } else if (f.mimeType.startsWith("application/vnd.google-apps.")) {
            continue;
          } else {
            if (out.has(path)) {
              throw new Error(`Drive contains duplicate path '${path}'. Resolve it before syncing.`);
            }
            out.set(path, { ...f, path });
          }
        }
        pageToken = j.nextPageToken ?? "";
      } while (pageToken);
    };
    await walk(rootId, "", 0);
    return out;
  }

  async download(
    fileId: string,
    expectedRevision?: string,
    expectedSize?: number
  ): Promise<ArrayBuffer> {
    await this.assertRevision(fileId, expectedRevision);
    const res = await this.call(`${this.ep.api}/files/${fileId}?alt=media`);
    if (expectedSize !== undefined && res.arrayBuffer.byteLength !== expectedSize) {
      throw new Error("Drive download size did not match the planned metadata.");
    }
    await this.assertRevision(fileId, expectedRevision);
    return res.arrayBuffer;
  }

  // Create or update a file with multipart upload (metadata + bytes).
  async upload(
    name: string,
    parentId: string,
    content: ArrayBuffer,
    existingId?: string,
    expectedRevision?: string
  ): Promise<{ id: string; md5Checksum?: string }> {
    if (!existingId) {
      const existing = this.unique(
        await this.findChildren(name, parentId, false),
        `file '${name}'`
      );
      if (existing) {
        const existingBytes = await this.download(existing.id);
        if (!sameBytes(existingBytes, content)) {
          throw new Error(`Drive file '${name}' appeared concurrently with different content.`);
        }
        return { id: existing.id, md5Checksum: existing.md5Checksum };
      }
    }
    if (existingId) await this.assertRevision(existingId, expectedRevision);
    let lastError: unknown;
    const attempts = existingId ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const boundary = "ogds" + Math.random().toString(36).slice(2);
      const meta = existingId ? { name } : { name, parents: [parentId] };
      const head =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(meta) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
      const tail = `\r\n--${boundary}--`;
      const enc = new TextEncoder();
      const headB = enc.encode(head);
      const tailB = enc.encode(tail);
      const body = new Uint8Array(headB.length + content.byteLength + tailB.length);
      body.set(headB, 0);
      body.set(new Uint8Array(content), headB.length);
      body.set(tailB, headB.length + content.byteLength);

      const url = existingId
        ? `${this.ep.upload}/files/${existingId}?uploadType=multipart&fields=id,md5Checksum`
        : `${this.ep.upload}/files?uploadType=multipart&fields=id,md5Checksum`;
      try {
        const res = await this.call(url, {
          method: existingId ? "PATCH" : "POST",
          retry: existingId ? "safe" : "none",
          contentType: `multipart/related; boundary=${boundary}`,
          body: body.buffer,
        });
        return res.json as { id: string; md5Checksum?: string };
      } catch (error) {
        lastError = error;
        if (existingId) throw error;
        const candidates = await this.findChildren(name, parentId, false);
        const recovered = this.unique(candidates, `file '${name}'`);
        if (recovered) {
          const remoteBytes = await this.download(recovered.id);
          if (!sameBytes(remoteBytes, content)) {
            throw new Error(`Drive file '${name}' appeared concurrently with different content.`);
          }
          return { id: recovered.id, md5Checksum: recovered.md5Checksum };
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Drive file creation failed.");
  }

  // Rename and, if needed, move a file to a different parent folder.
  async move(
    fileId: string,
    newName: string,
    newParentId: string,
    expectedRevision?: string
  ): Promise<void> {
    await this.assertRevision(fileId, expectedRevision);
    const cur = await this.call(`${this.ep.api}/files/${fileId}?fields=parents`);
    const parents = ((cur.json as { parents?: string[] }).parents ?? []).join(",");
    const q = parents
      ? `?addParents=${newParentId}&removeParents=${parents}`
      : `?addParents=${newParentId}`;
    await this.call(`${this.ep.api}/files/${fileId}${q}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ name: newName }),
    });
  }

  async trash(fileId: string, expectedRevision?: string): Promise<void> {
    await this.assertRevision(fileId, expectedRevision);
    await this.call(`${this.ep.api}/files/${fileId}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }

  // Ensure nested folders exist for a path like "notes/daily/2026".
  async ensurePath(rootId: string, folders: string[], cache: Map<string, string>): Promise<string> {
    let parent = rootId;
    let key = "";
    for (const part of folders) {
      key = key ? `${key}/${part}` : part;
      const hit = cache.get(key);
      if (hit) {
        parent = hit;
        continue;
      }
      parent = await this.ensureFolder(part, parent);
      cache.set(key, parent);
    }
    return parent;
  }
}
