import { strict as assert } from "node:assert";
import { startMockR2Worker } from "./mock-r2.mjs";
import R2SyncPlugin from "./main.build.mjs";
import { Notice, TFile } from "./obsidian-shim.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
if (typeof globalThis.document === "undefined") {
  globalThis.document = { visibilityState: "visible" };
}

function exactBuffer(value) {
  const source = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  const secrets = new Map();
  const app = {
    vault,
    secretStorage: {
      getSecret: (id) => secrets.get(id) ?? null,
      setSecret: (id, value) => { secrets.set(id, value); },
      listSecrets: () => [...secrets.keys()],
    },
    fileManager: {
      async renameFile(file, path) {
        const entry = vault.entries.get(file.path);
        vault.entries.delete(file.path);
        file.path = path;
        vault.entries.set(path, entry);
      },
      async trashFile(file) { vault.entries.delete(file.path); },
    },
    workspace: {
      activeFile: null,
      getActiveFile() { return this.activeFile; },
      getLeavesOfType() { return []; },
      on() { return {}; },
      onLayoutReady(callback) { callback(); },
    },
  };
  return app;
}

function configure(plugin, mock) {
  plugin.settings = {
    workerUrl: mock.workerUrl,
    vaultId: "owen-mobile",
    tokenSecretId: "owen-r2-sync-token",
    deviceId: "device-executor-0001",
    syncOnStartup: true,
    excludedFolders: [],
  };
  plugin.app.secretStorage.setSecret(plugin.settings.tokenSecretId, mock.token);
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
        rev: file.revision,
        size: Number(file.size ?? 0),
        mtime: file.modifiedTime ? Date.parse(file.modifiedTime) : undefined,
        hash: file.md5Checksum,
      },
    ])
  );
}

function snapshot({ rootId, base = {}, local, remote = {}, actions, fingerprint }) {
  return {
    rootId,
    identity: `owen-mobile:mock:${rootId}`,
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

// History controls are explicit foreground commands. Loading the plugin,
// registering startup/resume/edit hooks, and disabling an unsupported
// capability make no history requests.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "note.md": "local" });
  const plugin = new R2SyncPlugin(app);
  plugin.__data = {
    schemaVersion: 2,
    settings: {
      workerUrl: mock.workerUrl,
      vaultId: "owen-mobile",
      tokenSecretId: "owen-r2-sync-token",
      deviceId: "device-command-0001",
      syncOnStartup: false,
      excludedFolders: [],
    },
    rootFolderId: "owen-mobile",
    base: {},
    baselineIdentity: null,
    firstSyncApproved: false,
    journal: null,
  };
  app.secretStorage.setSecret("owen-r2-sync-token", mock.token);
  mock.resetHistoryRequests();
  await plugin.onload();
  assert.equal(mock.historyRequests, 0);
  const activeHistory = plugin.__commands.find((command) => command.id === "active-file-version-history");
  const deletedHistory = plugin.__commands.find((command) => command.id === "recover-recently-deleted");
  assert.ok(activeHistory?.checkCallback);
  assert.ok(deletedHistory?.checkCallback);
  mock.state.historyProtocol = null;
  assert.equal(await plugin.historyClient(), null);
  assert.equal(plugin.historyCapability, false);
  assert.equal(activeHistory.checkCallback(true), false);
  assert.equal(deletedHistory.checkCallback(true), false);
  plugin.onunload();
  await mock.close();
}

// Version-1 Google credentials are dropped during the schema migration and
// never copied into the R2 plugin's data.json.
{
  const app = makeApp();
  const plugin = new R2SyncPlugin(app);
  plugin.__data = {
    settings: {
      clientId: "old-client-id",
      clientSecret: "old-client-secret",
      driveFolderName: "old-drive-folder",
      syncOnStartup: false,
      excludedFolders: ["private"],
    },
    tokens: { refreshToken: "old-refresh-token" },
    base: { stale: { fileId: "old", localMtime: 1, remoteRev: "old" } },
  };
  await plugin.loadPersisted();
  assert.equal("clientId" in plugin.settings, false);
  assert.equal("clientSecret" in plugin.settings, false);
  assert.equal(plugin.settings.syncOnStartup, false);
  assert.deepEqual(plugin.settings.excludedFolders, ["private"]);
  assert.equal(plugin.__data.tokens, undefined);
  assert.deepEqual(plugin.base, {});
}

// Partial failure leaves a journal and a repeat-safe plan. The second run
// reconciles the committed first file and creates the failed file once.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "a.md": "alpha", "b.md": "bravo" });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const rootId = await r2.ensureFolder("owen-mobile");
  const local = {
    "a.md": await localEntry(app.vault, "a.md"),
    "b.md": await localEntry(app.vault, "b.md"),
  };
  mock.state.rejectPath = "b.md";
  await assert.rejects(
    () => plugin.executeSnapshot(
      r2,
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
    /Injected upload rejection/
  );
  assert.ok(plugin.journal, "interrupted run must retain its journal");
  assert.equal([...mock.objects.values()].filter((file) => file.path === "a.md").length, 1);
  assert.equal([...mock.objects.values()].filter((file) => file.path === "b.md").length, 0);

  mock.state.rejectPath = null;
  const rebuilt = await plugin.preparePlan(r2);
  assert.deepEqual(rebuilt.actions.map((action) => action.kind), ["adopt", "uploadNew"]);
  await plugin.executeSnapshot(r2, rebuilt);
  assert.equal(plugin.journal, null);
  assert.equal([...mock.objects.values()].filter((file) => file.path === "a.md").length, 1);
  assert.equal([...mock.objects.values()].filter((file) => file.path === "b.md").length, 1);
  await mock.close();
}

// Stable mtime/size reuses the persisted hash, while a stat change hashes only
// that file. Mandatory omissions are surfaced in preview warnings.
{
  const app = makeApp({
    "note.md": "stable",
    ".obsidian/plugins/example/data.json": "secret",
    "Archive/hidden.md": "archived note",
  });
  const plugin = new R2SyncPlugin(app);
  plugin.settings = {
    workerUrl: "https://worker.example.com",
    vaultId: "owen-mobile",
    tokenSecretId: "owen-r2-sync-token",
    deviceId: "device-hash-test",
    syncOnStartup: true,
    excludedFolders: [],
  };
  const note = await localEntry(app.vault, "note.md");
  plugin.rootFolderId = "root-id";
  plugin.firstSyncApproved = true;
  plugin.baselineIdentity = "owen-mobile:https://worker.example.com:owen-mobile";
  plugin.base = {
    "note.md": {
      fileId: "note-id",
      localMtime: note.mtime,
      localSize: note.size,
      localHash: note.hash,
      remoteRev: "remote-rev",
    },
  };
  const fakeR2 = {
    async verifyFolder() {},
    async listTree() {
      return new Map([
        ["note.md", {
          id: "note-id",
          name: "note.md",
          mimeType: "text/markdown",
          revision: "remote-rev",
          md5Checksum: note.hash,
          size: String(note.size),
          path: "note.md",
        }],
      ]);
    },
  };
  app.vault.readBinaryCount = 0;
  const unchanged = await plugin.preparePlan(fakeR2);
  assert.equal(app.vault.readBinaryCount, 0);
  assert.deepEqual(unchanged.actions, []);
  assert.match(unchanged.warnings.join("\n"), /2 files were omitted/);

  app.vault.entries.get("note.md").file.stat.mtime++;
  await plugin.preparePlan(fakeR2);
  assert.equal(app.vault.readBinaryCount, 1);
}

// A text conflict keeps both inputs in markers plus a sibling R2 copy.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "note.md": "local version" });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const rootId = await r2.ensureFolder("owen-mobile");
  const initial = await r2.upload("note.md", "", exactBuffer("base version"), undefined, undefined, undefined, 1000);
  await plugin.writeBaseCopy("note.md", "base version");
  const updated = await r2.upload(
    "note.md",
    "",
    exactBuffer("remote version"),
    initial.id,
    initial.revision,
    undefined,
    2000
  );
  const local = { "note.md": await localEntry(app.vault, "note.md") };
  const remote = remoteRecord(await r2.listTree(rootId));
  const base = {
    "note.md": {
      fileId: initial.id,
      localMtime: local["note.md"].mtime,
      localSize: local["note.md"].size,
      localHash: await hash("base version"),
      remoteRev: initial.revision,
    },
  };
  await plugin.executeSnapshot(
    r2,
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
  const r2Copy = [...app.vault.entries.keys()].find((path) =>
    path.startsWith("note (R2 conflict ")
  );
  assert.ok(r2Copy);
  assert.equal(app.vault.text(r2Copy), "remote version");
  assert.match(decoder.decode(await r2.download(updated.id)), /<<<<<<< LOCAL/);
  await mock.close();
}

// Structured JSON/canvas conflicts take the binary preservation path so the
// canonical file stays valid and the local input remains a valid sibling copy.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "board.canvas": '{"nodes":[{"id":"local"}]}' });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const rootId = await r2.ensureFolder("owen-mobile");
  const initial = await r2.upload("board.canvas", "", exactBuffer('{"nodes":[]}'), undefined, undefined, undefined, 1000);
  const updated = await r2.upload(
    "board.canvas",
    "",
    exactBuffer('{"nodes":[{"id":"remote"}]}'),
    initial.id,
    initial.revision,
    undefined,
    2000
  );
  const local = { "board.canvas": await localEntry(app.vault, "board.canvas") };
  const remote = remoteRecord(await r2.listTree(rootId));
  await plugin.executeSnapshot(
    r2,
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
  await mock.close();
}

// A clean three-way text merge is not reported as a preserved conflict.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "clean.md": "a\nB" });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const rootId = await r2.ensureFolder("owen-mobile");
  const initial = await r2.upload("clean.md", "", exactBuffer("a\nb"), undefined, undefined, undefined, 1000);
  await plugin.writeBaseCopy("clean.md", "a\nb");
  const updated = await r2.upload(
    "clean.md",
    "",
    exactBuffer("A\nb"),
    initial.id,
    initial.revision,
    undefined,
    2000
  );
  const local = { "clean.md": await localEntry(app.vault, "clean.md") };
  Notice.messages.length = 0;
  await plugin.executeSnapshot(
    r2,
    snapshot({
      rootId,
      base: {
        "clean.md": {
          fileId: initial.id,
          localMtime: local["clean.md"].mtime,
          localSize: local["clean.md"].size,
          localHash: await hash("a\nb"),
          remoteRev: initial.revision,
        },
      },
      local,
      remote: remoteRecord(await r2.listTree(rootId)),
      actions: [{ kind: "conflict", path: "clean.md", fileId: updated.id }],
      fingerprint: "clean-merge",
    })
  );
  assert.equal(app.vault.text("clean.md"), "A\nB");
  assert.equal(Notice.messages.some((message) => message.includes("conflict(s) preserved")), false);
  await mock.close();
}

// Base-copy replacement restores the old file if temp -> destination rename
// fails, leaving no backup or temporary artifact behind.
{
  const app = makeApp();
  const plugin = new R2SyncPlugin(app);
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
  const plugin = new R2SyncPlugin(app);
  const mock = await startMockR2Worker();
  configure(plugin, mock);
  const fakeR2 = {
    async verifyFolder() {},
    async listTree() { return new Map(); },
  };
  plugin.client = () => fakeR2;
  Notice.messages.length = 0;
  await plugin.syncNow(false, "automatic");
  await plugin.syncNow(false, "automatic");
  assert.equal(
    Notice.messages.filter((message) => message.includes("paused for review")).length,
    1
  );

  plugin.rootFolderId = "stale-root";
  plugin.base = { stale: { fileId: "x", localMtime: 1, remoteRev: "r" } };
  plugin.baselineIdentity = "owen-mobile:mock:stale-root";
  plugin.firstSyncApproved = true;
  plugin.journal = { identity: "old", fingerprint: "old", startedAt: 1 };
  const token = app.secretStorage.getSecret(plugin.settings.tokenSecretId);
  await plugin.resetBaseline();
  assert.equal(app.secretStorage.getSecret(plugin.settings.tokenSecretId), token);
  assert.equal(plugin.rootFolderId, null);
  assert.deepEqual(plugin.base, {});
  assert.equal(plugin.firstSyncApproved, false);
  assert.equal(plugin.journal, null);
  await mock.close();
}

// Steady-state automatic sync retains the one-index contract and never probes
// history endpoints.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "steady.md": "unchanged" });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const remote = await r2.upload(
    "steady.md",
    "",
    exactBuffer("unchanged"),
    undefined,
    undefined,
    undefined,
    app.vault.entries.get("steady.md").file.stat.mtime
  );
  const local = await localEntry(app.vault, "steady.md");
  plugin.firstSyncApproved = true;
  plugin.baselineIdentity = `owen-mobile:${mock.workerUrl}:owen-mobile`;
  plugin.base = {
    "steady.md": {
      fileId: remote.id,
      localMtime: local.mtime,
      localSize: local.size,
      localHash: local.hash,
      remoteRev: remote.revision,
    },
  };
  mock.resetHistoryRequests();
  await plugin.syncNow(false, "automatic");
  assert.equal(mock.historyRequests, 0);
  await mock.close();
}

// The plugin-wide mutex is owned before history capability health resolves.
// A competing restore and a normal sync are both rejected, and neither can
// clear the first restore's lock while its health request remains deferred.
{
  const app = makeApp();
  const plugin = new R2SyncPlugin(app);
  const health = deferred();
  let clientCalls = 0;
  let healthCalls = 0;
  let prepareCalls = 0;
  plugin.client = () => {
    clientCalls++;
    return {
      async health() {
        healthCalls++;
        return health.promise;
      },
    };
  };
  plugin.preparePlan = async () => {
    prepareCalls++;
    throw new Error("sync must not start while history health is pending");
  };
  const current = {
    id: "history-lock-id",
    path: "history-lock.md",
    revision: "current-revision",
    deleted: false,
  };
  const version = {
    fileId: current.id,
    versionId: "history-version",
    sha256: "history-sha",
    path: current.path,
    sourceRevision: "source-revision",
    size: 1,
    deleted: false,
  };

  const firstRestore = plugin.restoreHistoryVersion(current, version, "approved");
  assert.equal(plugin.syncing, true);
  assert.equal(clientCalls, 1);
  assert.equal(healthCalls, 1);

  assert.equal(await plugin.restoreHistoryVersion(current, version, "approved"), false);
  assert.equal(plugin.syncing, true, "a rejected restore must not clear the active owner's lock");
  assert.equal(clientCalls, 1, "a rejected restore must not start another health request");
  assert.equal(healthCalls, 1);

  await plugin.syncNow(false, "manual");
  assert.equal(plugin.syncing, true, "a rejected sync must not clear the history owner's lock");
  assert.equal(clientCalls, 1, "sync must stop before creating a client while history health is pending");
  assert.equal(prepareCalls, 0, "sync planning must not overlap history health");

  health.resolve({ historyProtocol: null });
  assert.equal(await firstRestore, false);
  assert.equal(plugin.syncing, false);
}

// An approved historical restore changes R2 first. Normal sync then downloads
// it when the local file is unchanged.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "restore.md": "current" });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const old = await r2.upload("restore.md", "", exactBuffer("old"), undefined, undefined, undefined, 1000);
  const current = await r2.upload(
    "restore.md",
    "",
    exactBuffer("current"),
    old.id,
    old.revision,
    undefined,
    2000
  );
  const local = await localEntry(app.vault, "restore.md");
  plugin.firstSyncApproved = true;
  plugin.baselineIdentity = `owen-mobile:${mock.workerUrl}:owen-mobile`;
  plugin.base = {
    "restore.md": {
      fileId: current.id,
      localMtime: local.mtime,
      localSize: local.size,
      localHash: local.hash,
      remoteRev: current.revision,
    },
  };
  const tree = await r2.listTree("owen-mobile");
  const approvedCurrent = tree.get("restore.md");
  const oldHash = await hash("old");
  const version = (await r2.listHistory(current.id, 50)).versions.find((item) => item.sha256 === oldHash);
  assert.ok(version);
  const fingerprint = await plugin.historyApprovalFingerprint(approvedCurrent, version);
  mock.resetHistoryDownloadRequests();
  assert.equal(await plugin.restoreHistoryVersion(approvedCurrent, version, fingerprint), true);
  assert.equal(mock.historyDownloadRequests, 0, "restore must not download history bytes to the client");
  assert.equal(app.vault.text("restore.md"), "old");
  await mock.close();
}

// Current-revision drift invalidates the explicit approval fingerprint before
// the restore mutation can run.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "drift.md": "current" });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const old = await r2.upload("drift.md", "", exactBuffer("old"), undefined, undefined, undefined, 1000);
  const current = await r2.upload("drift.md", "", exactBuffer("current"), old.id, old.revision, undefined, 2000);
  const approvedCurrent = (await r2.listTree("owen-mobile")).get("drift.md");
  const version = (await r2.listHistory(current.id, 50)).versions[0];
  const fingerprint = await plugin.historyApprovalFingerprint(approvedCurrent, version);
  const drifted = await r2.upload(
    "drift.md",
    "",
    exactBuffer("drifted"),
    current.id,
    current.revision,
    undefined,
    3000
  );
  assert.equal(await plugin.restoreHistoryVersion(approvedCurrent, version, fingerprint), false);
  assert.equal(mock.objects.get("drift.md").revision, drifted.revision);
  assert.equal(decoder.decode(mock.objects.get("drift.md").body), "drifted");
  await mock.close();
}

// A local edit made after approval is not overwritten by history. The remote
// restore completes, then the normal sync that follows runs unattended: the
// conflict action preserves both inputs without a manual approval step.
{
  const mock = await startMockR2Worker();
  const app = makeApp({ "concurrent.md": "current" });
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const old = await r2.upload("concurrent.md", "", exactBuffer("old"), undefined, undefined, undefined, 1000);
  const current = await r2.upload(
    "concurrent.md",
    "",
    exactBuffer("current"),
    old.id,
    old.revision,
    undefined,
    2000
  );
  const baselineLocal = await localEntry(app.vault, "concurrent.md");
  plugin.firstSyncApproved = true;
  plugin.baselineIdentity = `owen-mobile:${mock.workerUrl}:owen-mobile`;
  plugin.base = {
    "concurrent.md": {
      fileId: current.id,
      localMtime: baselineLocal.mtime,
      localSize: baselineLocal.size,
      localHash: baselineLocal.hash,
      remoteRev: current.revision,
    },
  };
  await plugin.writeBaseCopy("concurrent.md", "current");
  const approvedCurrent = (await r2.listTree("owen-mobile")).get("concurrent.md");
  const version = (await r2.listHistory(current.id, 50)).versions[0];
  const fingerprint = await plugin.historyApprovalFingerprint(approvedCurrent, version);
  await app.vault.modify(app.vault.getAbstractFileByPath("concurrent.md"), "local edit");
  assert.equal(await plugin.restoreHistoryVersion(approvedCurrent, version, fingerprint), true);
  assert.match(app.vault.text("concurrent.md"), /local edit/);
  assert.match(app.vault.text("concurrent.md"), /old/);
  // Only the preserved conflict copy remains to upload; no further conflict or delete.
  const settledPlan = await plugin.preparePlan(plugin.client());
  assert.ok(settledPlan.actions.every((action) => action.kind === "uploadNew"));
  await mock.close();
}

// Recently deleted candidates are stable-file-ID tombstones. Restoring their
// latest live history version is server-side and normal sync recreates local.
{
  const mock = await startMockR2Worker();
  const app = makeApp();
  const plugin = new R2SyncPlugin(app);
  configure(plugin, mock);
  const r2 = plugin.client();
  const initial = await r2.upload("deleted.md", "", exactBuffer("recover me"), undefined, undefined, undefined, 1000);
  await r2.trash(initial.id, initial.revision);
  await r2.listTree("owen-mobile");
  const current = r2.deletedFiles()[0];
  const version = (await r2.listHistory(initial.id, 50)).versions.find((item) => !item.deleted);
  assert.ok(current?.deleted);
  assert.ok(version);
  plugin.firstSyncApproved = true;
  plugin.baselineIdentity = `owen-mobile:${mock.workerUrl}:owen-mobile`;
  const fingerprint = await plugin.historyApprovalFingerprint(current, version);
  assert.equal(await plugin.restoreHistoryVersion(current, version, fingerprint), true);
  assert.equal(app.vault.text("deleted.md"), "recover me");
  await mock.close();
}

// Transfer concurrency is high for note-sized files and falls back before
// multiple large binaries can spike iOS memory.
{
  const app = makeApp();
  const plugin = new R2SyncPlugin(app);
  const makeSnapshot = (size) => snapshot({
    rootId: "owen-mobile",
    local: { "file.bin": { mtime: 1, size, hash: "hash" } },
    actions: [{ kind: "uploadNew", path: "file.bin" }],
    fingerprint: `size-${size}`,
  });
  assert.equal(plugin.transferConcurrency(makeSnapshot(100).actions, makeSnapshot(100)), 6);
  assert.equal(plugin.transferConcurrency(makeSnapshot(2 * 1024 * 1024).actions, makeSnapshot(2 * 1024 * 1024)), 2);
  assert.equal(plugin.transferConcurrency(makeSnapshot(9 * 1024 * 1024).actions, makeSnapshot(9 * 1024 * 1024)), 1);
}

console.log("executor: repeat safety, conflicts, history restore, deletion recovery, and hash caching passed");
