import { strict as assert } from "node:assert";
import { startMockDrive } from "./mock-drive.mjs";
import DriveMergeSyncPlugin from "./main.build.mjs";
import { Notice, TFile } from "./obsidian-shim.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function exactBuffer(value) {
  const source = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", exactBuffer(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class MemoryAdapter {
  constructor(vault) {
    this.vault = vault;
    this.files = new Map();
    this.directories = new Set();
    this.failRenameToOnce = null;
  }
  async exists(path) {
    return this.files.has(path) || this.directories.has(path) || this.vault.entries.has(path);
  }
  async mkdir(path) {
    this.directories.add(path);
  }
  async write(path, content) {
    this.files.set(path, String(content));
  }
  async read(path) {
    if (!this.files.has(path)) throw new Error(`missing adapter file: ${path}`);
    return this.files.get(path);
  }
  async rename(from, to) {
    if (this.failRenameToOnce === to) {
      this.failRenameToOnce = null;
      throw new Error("injected adapter rename failure");
    }
    if (!this.files.has(from)) throw new Error(`missing adapter rename source: ${from}`);
    const value = this.files.get(from);
    this.files.delete(from);
    this.files.set(to, value);
  }
  async remove(path) {
    this.files.delete(path);
  }
  async list(dir) {
    const prefix = `${dir}/`;
    return {
      files: [...this.files.keys()].filter((path) => path.startsWith(prefix)),
      folders: [...this.directories].filter((path) => path.startsWith(prefix)),
    };
  }
  async rmdir(dir) {
    const prefix = `${dir}/`;
    for (const path of [...this.files.keys()]) {
      if (path === dir || path.startsWith(prefix)) this.files.delete(path);
    }
    for (const path of [...this.directories]) {
      if (path === dir || path.startsWith(prefix)) this.directories.delete(path);
    }
  }
  async stat(path) {
    return this.vault.entries.get(path)?.file.stat ?? null;
  }
}

class MemoryVault {
  constructor(initial = {}) {
    this.configDir = ".obsidian";
    this.entries = new Map();
    this.folders = new Set();
    this.readBinaryCount = 0;
    this.clock = 10_000;
    this.adapter = new MemoryAdapter(this);
    for (const [path, value] of Object.entries(initial)) this.put(path, value);
  }
  getName() { return "owen-mobile"; }
  put(path, value, mtime = this.clock++) {
    const bytes = exactBuffer(value);
    const file = new TFile(path, bytes, mtime);
    this.entries.set(path, { file, bytes });
    return file;
  }
  bytes(path) { return exactBuffer(this.entries.get(path).bytes); }
  text(path) { return decoder.decode(this.entries.get(path).bytes); }
  getFiles() { return [...this.entries.values()].map((entry) => entry.file); }
  getAbstractFileByPath(path) {
    return this.entries.get(path)?.file ?? (this.folders.has(path) ? { path } : null);
  }
  async readBinary(file) {
    this.readBinaryCount++;
    return this.bytes(file.path);
  }
  async read(file) { return this.text(file.path); }
  async modifyBinary(file, value) {
    const bytes = exactBuffer(value);
    const entry = this.entries.get(file.path);
    entry.bytes = bytes;
    file.stat = { mtime: this.clock++, size: bytes.byteLength };
  }
  async modify(file, value) { await this.modifyBinary(file, exactBuffer(value)); }
  async createBinary(path, value) {
    if (this.entries.has(path)) throw new Error(`duplicate local file: ${path}`);
    return this.put(path, value);
  }
  async createFolder(path) { this.folders.add(path); }
  async on() { return {}; }
}

function makeApp(initial) {
  const vault = new MemoryVault(initial);
  const app = {
    vault,
    fileManager: {
      async renameFile(file, path) {
        const entry = vault.entries.get(file.path);
        vault.entries.delete(file.path);
        file.path = path;
        vault.entries.set(path, entry);
      },
      async trashFile(file) { vault.entries.delete(file.path); },
    },
  };
  return app;
}

function configure(plugin, endpoints) {
  plugin.settings = {
    clientId: "client-id",
    clientSecret: "client-secret",
    driveFolderName: "Vault",
    syncOnStartup: true,
    excludedFolders: [],
  };
  plugin.tokens = {
    accessToken: "mock-access",
    refreshToken: "mock-refresh",
    expiresAt: Date.now() + 60_000,
  };
  plugin.debugEndpoints = endpoints;
}

async function localEntry(vault, path) {
  const file = vault.entries.get(path).file;
  return { mtime: file.stat.mtime, size: file.stat.size, hash: await hash(vault.bytes(path)) };
}

function remoteRecord(tree) {
  return Object.fromEntries(
    [...tree].map(([path, file]) => [
      path,
      {
        fileId: file.id,
        rev: file.md5Checksum ?? file.modifiedTime ?? "",
        size: Number(file.size ?? 0),
        mtime: file.modifiedTime ? Date.parse(file.modifiedTime) : undefined,
      },
    ])
  );
}

function snapshot({ rootId, base = {}, local, remote = {}, actions, fingerprint }) {
  return {
    rootId,
    identity: `owen-mobile:${rootId}`,
    base,
    local,
    remote,
    actions,
    fingerprint,
    firstSync: Object.keys(base).length === 0,
    warnings: [],
    requiresApproval: true,
  };
}

// Partial failure leaves a journal and a repeat-safe plan. The second run
// reconciles the committed first file and creates the failed file once.
{
  const mock = await startMockDrive();
  const app = makeApp({ "a.md": "alpha", "b.md": "bravo" });
  const plugin = new DriveMergeSyncPlugin(app);
  configure(plugin, mock.endpoints);
  const drive = plugin.client();
  const rootId = await drive.ensureFolder("Vault");
  const local = {
    "a.md": await localEntry(app.vault, "a.md"),
    "b.md": await localEntry(app.vault, "b.md"),
  };
  mock.state.rejectUploadName = "b.md";
  await assert.rejects(
    () => plugin.executeSnapshot(
      drive,
      snapshot({
        rootId,
        local,
        actions: [
          { kind: "uploadNew", path: "a.md" },
          { kind: "uploadNew", path: "b.md" },
        ],
        fingerprint: "partial-first",
      })
    ),
    /Drive returned 413/
  );
  assert.ok(plugin.journal, "interrupted run must retain its journal");
  assert.equal([...mock.files.values()].filter((file) => file.name === "a.md").length, 1);
  assert.equal([...mock.files.values()].filter((file) => file.name === "b.md").length, 0);

  mock.state.rejectUploadName = null;
  const rebuilt = await plugin.preparePlan(drive);
  assert.deepEqual(rebuilt.actions.map((action) => action.kind), ["conflict", "uploadNew"]);
  await plugin.executeSnapshot(drive, rebuilt);
  assert.equal(plugin.journal, null);
  assert.equal([...mock.files.values()].filter((file) => file.name === "a.md").length, 1);
  assert.equal([...mock.files.values()].filter((file) => file.name === "b.md").length, 1);
  mock.close();
}

// Stable mtime/size reuses the persisted hash, while a stat change hashes only
// that file. Mandatory omissions are surfaced in preview warnings.
{
  const app = makeApp({
    "note.md": "stable",
    ".obsidian/plugins/example/data.json": "secret",
    "Archive/hidden.md": "archived note",
  });
  const plugin = new DriveMergeSyncPlugin(app);
  const note = await localEntry(app.vault, "note.md");
  plugin.rootFolderId = "root-id";
  plugin.firstSyncApproved = true;
  plugin.baselineIdentity = "owen-mobile:root-id";
  plugin.base = {
    "note.md": {
      fileId: "note-id",
      localMtime: note.mtime,
      localSize: note.size,
      localHash: note.hash,
      remoteRev: "remote-rev",
    },
  };
  const fakeDrive = {
    async verifyFolder() {},
    async listTree() {
      return new Map([
        ["note.md", {
          id: "note-id",
          name: "note.md",
          mimeType: "text/markdown",
          md5Checksum: "remote-rev",
          size: String(note.size),
          path: "note.md",
        }],
      ]);
    },
  };
  app.vault.readBinaryCount = 0;
  const unchanged = await plugin.preparePlan(fakeDrive);
  assert.equal(app.vault.readBinaryCount, 0);
  assert.deepEqual(unchanged.actions, []);
  assert.match(unchanged.warnings.join("\n"), /2 files were omitted/);

  app.vault.entries.get("note.md").file.stat.mtime++;
  await plugin.preparePlan(fakeDrive);
  assert.equal(app.vault.readBinaryCount, 1);
}

// A text conflict keeps both inputs in markers plus a sibling Drive copy.
{
  const mock = await startMockDrive();
  const app = makeApp({ "note.md": "local version" });
  const plugin = new DriveMergeSyncPlugin(app);
  configure(plugin, mock.endpoints);
  const drive = plugin.client();
  const rootId = await drive.ensureFolder("Vault");
  const initial = await drive.upload("note.md", rootId, exactBuffer("base version"));
  await plugin.writeBaseCopy("note.md", "base version");
  const updated = await drive.upload(
    "note.md",
    rootId,
    exactBuffer("remote version"),
    initial.id,
    initial.md5Checksum
  );
  const local = { "note.md": await localEntry(app.vault, "note.md") };
  const remote = remoteRecord(await drive.listTree(rootId));
  const base = {
    "note.md": {
      fileId: initial.id,
      localMtime: local["note.md"].mtime,
      localSize: local["note.md"].size,
      localHash: await hash("base version"),
      remoteRev: initial.md5Checksum,
    },
  };
  await plugin.executeSnapshot(
    drive,
    snapshot({
      rootId,
      base,
      local,
      remote,
      actions: [{ kind: "conflict", path: "note.md", fileId: updated.id }],
      fingerprint: "text-conflict",
    })
  );
  assert.match(app.vault.text("note.md"), /<<<<<<< LOCAL/);
  assert.match(app.vault.text("note.md"), /local version/);
  assert.match(app.vault.text("note.md"), /remote version/);
  const driveCopy = [...app.vault.entries.keys()].find((path) =>
    path.startsWith("note (Drive conflict ")
  );
  assert.ok(driveCopy);
  assert.equal(app.vault.text(driveCopy), "remote version");
  assert.match(decoder.decode(await drive.download(updated.id)), /<<<<<<< LOCAL/);
  mock.close();
}

// Structured JSON/canvas conflicts take the binary preservation path so the
// canonical file stays valid and the local input remains a valid sibling copy.
{
  const mock = await startMockDrive();
  const app = makeApp({ "board.canvas": '{"nodes":[{"id":"local"}]}' });
  const plugin = new DriveMergeSyncPlugin(app);
  configure(plugin, mock.endpoints);
  const drive = plugin.client();
  const rootId = await drive.ensureFolder("Vault");
  const initial = await drive.upload("board.canvas", rootId, exactBuffer('{"nodes":[]}'));
  const updated = await drive.upload(
    "board.canvas",
    rootId,
    exactBuffer('{"nodes":[{"id":"remote"}]}'),
    initial.id,
    initial.md5Checksum
  );
  const local = { "board.canvas": await localEntry(app.vault, "board.canvas") };
  const remote = remoteRecord(await drive.listTree(rootId));
  await plugin.executeSnapshot(
    drive,
    snapshot({
      rootId,
      base: {},
      local,
      remote,
      actions: [{ kind: "conflict", path: "board.canvas", fileId: updated.id }],
      fingerprint: "canvas-conflict",
    })
  );
  assert.equal(JSON.parse(app.vault.text("board.canvas")).nodes[0].id, "remote");
  const localCopy = [...app.vault.entries.keys()].find((path) =>
    path.startsWith("board (Local conflict ")
  );
  assert.ok(localCopy);
  assert.equal(JSON.parse(app.vault.text(localCopy)).nodes[0].id, "local");
  mock.close();
}

// A clean three-way text merge is not reported as a preserved conflict.
{
  const mock = await startMockDrive();
  const app = makeApp({ "clean.md": "a\nB" });
  const plugin = new DriveMergeSyncPlugin(app);
  configure(plugin, mock.endpoints);
  const drive = plugin.client();
  const rootId = await drive.ensureFolder("Vault");
  const initial = await drive.upload("clean.md", rootId, exactBuffer("a\nb"));
  await plugin.writeBaseCopy("clean.md", "a\nb");
  const updated = await drive.upload(
    "clean.md",
    rootId,
    exactBuffer("A\nb"),
    initial.id,
    initial.md5Checksum
  );
  const local = { "clean.md": await localEntry(app.vault, "clean.md") };
  Notice.messages.length = 0;
  await plugin.executeSnapshot(
    drive,
    snapshot({
      rootId,
      base: {
        "clean.md": {
          fileId: initial.id,
          localMtime: local["clean.md"].mtime,
          localSize: local["clean.md"].size,
          localHash: await hash("a\nb"),
          remoteRev: initial.md5Checksum,
        },
      },
      local,
      remote: remoteRecord(await drive.listTree(rootId)),
      actions: [{ kind: "conflict", path: "clean.md", fileId: updated.id }],
      fingerprint: "clean-merge",
    })
  );
  assert.equal(app.vault.text("clean.md"), "A\nB");
  assert.equal(Notice.messages.some((message) => message.includes("conflict(s) preserved")), false);
  mock.close();
}

// Base-copy replacement restores the old file if temp -> destination rename
// fails, leaving no backup or temporary artifact behind.
{
  const app = makeApp();
  const plugin = new DriveMergeSyncPlugin(app);
  await plugin.writeBaseCopy("rollback.md", "old baseline");
  const destination = await plugin.basePath("rollback.md");
  app.vault.adapter.failRenameToOnce = destination;
  await assert.rejects(() => plugin.writeBaseCopy("rollback.md", "new baseline"));
  assert.equal(await app.vault.adapter.read(destination), "old baseline");
  assert.equal(await app.vault.adapter.exists(`${destination}.bak`), false);
  assert.equal(
    [...app.vault.adapter.files.keys()].some((path) => path.startsWith(`${destination}.`) && path.endsWith(".tmp")),
    false
  );
}

// Automatic approval pauses notify once per stable plan, and the recovery
// reset clears only sync identity/baseline state while retaining credentials.
{
  const app = makeApp({ "note.md": "first" });
  const plugin = new DriveMergeSyncPlugin(app);
  configure(plugin, {});
  const fakeDrive = {
    async findFolder() { return null; },
    async listTree() { return new Map(); },
  };
  plugin.client = () => fakeDrive;
  Notice.messages.length = 0;
  await plugin.syncNow(false, "automatic");
  await plugin.syncNow(false, "automatic");
  assert.equal(
    Notice.messages.filter((message) => message.includes("paused for review")).length,
    1
  );

  plugin.rootFolderId = "stale-root";
  plugin.base = { stale: { fileId: "x", localMtime: 1, remoteRev: "r" } };
  plugin.baselineIdentity = "owen-mobile:stale-root";
  plugin.firstSyncApproved = true;
  plugin.journal = { identity: "old", fingerprint: "old", startedAt: 1 };
  const credentials = plugin.tokens;
  await plugin.resetBaseline();
  assert.equal(plugin.tokens, credentials);
  assert.equal(plugin.rootFolderId, null);
  assert.deepEqual(plugin.base, {});
  assert.equal(plugin.firstSyncApproved, false);
  assert.equal(plugin.journal, null);
}

console.log("executor: repeat safety, conflicts, baseline recovery, and hash caching passed");
