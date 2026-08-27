import {
  App,
  FileView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import { DriveClient, DriveEndpoints, DriveTokens } from "./drive";
import { startLoopbackAuth } from "./auth";
import { ConnectWizard } from "./wizard";
import { BaseEntry, LocalEntry, RemoteEntry, planSync } from "./planner";
import { mergeTextPreservingBoth } from "./conflict";
import {
  actionFingerprint,
  assessPlanSafety,
  assertTargetVault,
  conflictCopyPath,
  describeAction,
  isMandatoryExcluded,
  partitionActions,
  sha256Hex,
} from "./safety";
import {
  decryptConnectionPayload,
  encryptConnectionPayload,
  importedTokens,
  presentConnectionCode,
} from "./connection";

export interface DriveMergeSettings {
  clientId: string;
  clientSecret: string;
  driveFolderName: string;
  syncOnStartup: boolean;
  excludedFolders: string[];
}

const DEFAULT_SETTINGS: DriveMergeSettings = {
  clientId: "",
  clientSecret: "",
  driveFolderName: "",
  syncOnStartup: true,
  excludedFolders: [],
};

// Serial transfers keep mobile memory bounded and make state checkpoints
// strictly ordered. The drained-worker structure still prevents orphan work.
const TRANSFER_CONCURRENCY = 1;

interface SyncJournal {
  identity: string;
  fingerprint: string;
  startedAt: number;
}

interface PersistedData {
  settings: DriveMergeSettings;
  tokens: DriveTokens | null;
  rootFolderId: string | null;
  base: Record<string, BaseEntry>;
  baselineIdentity: string | null;
  firstSyncApproved: boolean;
  journal: SyncJournal | null;
}

interface PlanSnapshot {
  rootId: string | null;
  identity: string | null;
  base: Record<string, BaseEntry>;
  local: Record<string, LocalEntry>;
  remote: Record<string, RemoteEntry>;
  actions: ReturnType<typeof planSync>;
  fingerprint: string;
  firstSync: boolean;
  warnings: string[];
  requiresApproval: boolean;
}

const TEXT_EXTENSIONS = new Set(["md", "txt"]);

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

export default class DriveMergeSyncPlugin extends Plugin {
  settings: DriveMergeSettings = DEFAULT_SETTINGS;
  private tokens: DriveTokens | null = null;
  private rootFolderId: string | null = null;
  private base: Record<string, BaseEntry> = {};
  private baselineIdentity: string | null = null;
  private firstSyncApproved = false;
  private journal: SyncJournal | null = null;
  private statusEl: HTMLElement | null = null;
  private syncing = false;
  private editDebounceHandle: number | null = null;
  private approvalNoticeFingerprint: string | null = null;
  private seenViews = new WeakSet<object>();
  private headerButtons = new Set<HTMLElement>();
  // Test hook: point the client at a mock Drive server instead of Google.
  debugEndpoints: Partial<DriveEndpoints> | null = null;

  async onload() {
    await this.loadPersisted();

    this.statusEl = this.addStatusBarItem();
    this.setStatus(this.tokens ? "ready" : "not connected");

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () =>
      void this.syncNow(false, "manual")
    );
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(false, "manual"),
    });
    this.addCommand({
      id: "dry-run",
      name: "Preview what a sync would do (dry run)",
      callback: () => void this.syncNow(true, "manual"),
    });
    this.addCommand({
      id: "reset-sync-baseline",
      name: "Reset sync baseline for recovery",
      callback: () => new BaselineResetModal(this.app, () => void this.resetBaseline()).open(),
    });

    this.addSettingTab(new DriveMergeSettingTab(this));

    // One cloud button in every note pane header: sync when connected,
    // open the setup wizard when not.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.ensureHeaderButtons()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.ensureHeaderButtons()));
    this.app.workspace.onLayoutReady(() => this.ensureHeaderButtons());

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.tokens) {
        void this.syncNow(false, "automatic");
      }
    });

    this.app.workspace.onLayoutReady(() => {
      const schedule = () => this.scheduleEditSync();
      this.registerEvent(this.app.vault.on("create", schedule));
      this.registerEvent(this.app.vault.on("modify", schedule));
      this.registerEvent(this.app.vault.on("delete", schedule));
      this.registerEvent(this.app.vault.on("rename", schedule));
    });

    if (this.settings.syncOnStartup && this.tokens) {
      this.app.workspace.onLayoutReady(() =>
        window.setTimeout(() => void this.syncNow(false, "automatic"), 3000)
      );
    }
  }

  onunload() {
    if (this.editDebounceHandle !== null) window.clearTimeout(this.editDebounceHandle);
    for (const el of this.headerButtons) el.detach();
    this.headerButtons.clear();
  }

  get connected(): boolean {
    return this.tokens !== null;
  }

  private ensureHeaderButtons() {
    for (const type of ["markdown", "pdf"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (!(view instanceof FileView) || this.seenViews.has(view)) continue;
        this.seenViews.add(view);
        const el = view.addAction("cloud", "Sync with Google Drive", () => {
          if (this.connected) void this.syncNow(false, "manual");
          else new ConnectWizard(this).open();
        });
        this.headerButtons.add(el);
      }
    }
  }

  private scheduleEditSync() {
    if (!this.tokens || !this.firstSyncApproved || document.visibilityState !== "visible") {
      return;
    }
    if (this.editDebounceHandle !== null) window.clearTimeout(this.editDebounceHandle);
    this.editDebounceHandle = window.setTimeout(() => {
      this.editDebounceHandle = null;
      void this.syncNow(false, "automatic");
    }, 30_000);
  }

  private async loadPersisted() {
    const raw = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings);
    this.tokens = raw?.tokens ?? null;
    this.rootFolderId = raw?.rootFolderId ?? null;
    this.base = raw?.base ?? {};
    this.baselineIdentity = raw?.baselineIdentity ?? null;
    this.firstSyncApproved = raw?.firstSyncApproved ?? false;
    this.journal = raw?.journal ?? null;
  }

  async persist() {
    const data: PersistedData = {
      settings: this.settings,
      tokens: this.tokens,
      rootFolderId: this.rootFolderId,
      base: this.base,
      baselineIdentity: this.baselineIdentity,
      firstSyncApproved: this.firstSyncApproved,
      journal: this.journal,
    };
    await this.saveData(data);
  }

  private setStatus(text: string) {
    this.statusEl?.setText(`Drive: ${text}`);
  }

  // ---- Connection -----------------------------------------------------------

  async exportConnectionCode(passphrase: string): Promise<string | null> {
    if (!this.tokens) return null;
    return encryptConnectionPayload({
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      refreshToken: this.tokens.refreshToken,
      rootFolderId: this.rootFolderId,
      driveFolderName: this.settings.driveFolderName,
    }, passphrase);
  }

  async importConnectionCode(code: string, passphrase: string): Promise<boolean> {
    try {
      const payload = await decryptConnectionPayload(code, passphrase);
      this.settings.clientId = payload.clientId;
      this.settings.clientSecret = payload.clientSecret;
      this.settings.driveFolderName = payload.driveFolderName;
      this.tokens = importedTokens(payload);
      this.rootFolderId = payload.rootFolderId;
      this.base = {};
      this.baselineIdentity = null;
      this.firstSyncApproved = false;
      this.journal = null;
      await this.clearBaselineFiles();
      await this.persist();
      this.setStatus("connected");
      return true;
    } catch (error) {
      console.error("Owen Google Drive Sync: connection code rejected", error);
      return false;
    }
  }

  async connect() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new ConnectWizard(this).open();
      return;
    }
    try {
      const result = await startLoopbackAuth(this.settings.clientId, (url) => {
        window.open(url);
        new Notice("Complete the Google sign-in in your browser.");
      });
      this.tokens = await DriveClient.exchangeCode(
        this.settings.clientId,
        this.settings.clientSecret,
        result.code,
        result.redirectUri,
        result.codeVerifier
      );
      this.rootFolderId = null;
      this.base = {};
      this.baselineIdentity = null;
      this.firstSyncApproved = false;
      this.journal = null;
      await this.clearBaselineFiles();
      await this.persist();
      this.setStatus("connected");
      new Notice("Google Drive connected.");
    } catch (e) {
      console.error("Owen Google Drive Sync: auth failed", e);
      new Notice(`Google sign-in failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async disconnect() {
    const refreshToken = this.tokens?.refreshToken;
    let revokeError: unknown = null;
    if (refreshToken) {
      try {
        await DriveClient.revokeToken(refreshToken, this.debugEndpoints?.revoke);
      } catch (error) {
        revokeError = error;
      }
    }
    this.tokens = null;
    this.rootFolderId = null;
    this.base = {};
    this.baselineIdentity = null;
    this.firstSyncApproved = false;
    this.journal = null;
    this.settings.clientId = "";
    this.settings.clientSecret = "";
    await this.clearBaselineFiles();
    await this.persist();
    this.setStatus("not connected");
    if (revokeError) {
      new Notice(
        "Local credentials were removed, but Google revocation could not be confirmed. Remove the app at myaccount.google.com/permissions."
      );
    }
  }

  async resetBaseline() {
    this.rootFolderId = null;
    this.base = {};
    this.baselineIdentity = null;
    this.firstSyncApproved = false;
    this.journal = null;
    this.approvalNoticeFingerprint = null;
    await this.clearBaselineFiles();
    await this.persist();
    this.setStatus(this.tokens ? "preview required" : "not connected");
    new Notice("Sync baseline reset. The next sync is a read-only first-sync preview.");
  }

  private client(): DriveClient | null {
    if (!this.tokens) return null;
    return new DriveClient(
      this.settings.clientId,
      this.settings.clientSecret,
      this.tokens,
      (t) => {
        this.tokens = t;
        void this.persist();
      },
      this.debugEndpoints ?? undefined
    );
  }

  // ---- Sync -----------------------------------------------------------------

  private excluded(path: string): boolean {
    if (isMandatoryExcluded(path, this.app.vault.configDir)) return true;
    for (const folder of this.settings.excludedFolders) {
      const clean = folder.trim().replace(/\/$/, "");
      if (clean && (path === clean || path.startsWith(clean + "/"))) return true;
    }
    return false;
  }

  private isTextPath(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return TEXT_EXTENSIONS.has(ext);
  }

  async syncNow(
    dryRun = false,
    trigger: "manual" | "automatic" = "manual",
    approvedFingerprint?: string
  ) {
    if (this.syncing) {
      if (trigger === "manual") new Notice("A sync is already running.");
      return;
    }
    const drive = this.client();
    if (!drive) {
      if (trigger === "manual") new ConnectWizard(this).open();
      return;
    }
    this.syncing = true;
    this.setStatus(dryRun ? "previewing…" : "syncing…");
    try {
      const snapshot = await this.preparePlan(drive);
      const approvalChanged =
        approvedFingerprint !== undefined && approvedFingerprint !== snapshot.fingerprint;
      if (dryRun || approvalChanged || (snapshot.requiresApproval && !approvedFingerprint)) {
        this.setStatus("preview required");
        if (trigger === "manual") {
          this.showPreview(snapshot);
        } else if (this.approvalNoticeFingerprint !== snapshot.fingerprint) {
          this.approvalNoticeFingerprint = snapshot.fingerprint;
          new Notice("Drive sync is paused for review. Run the preview command to approve it.");
        }
        return;
      }
      this.approvalNoticeFingerprint = null;
      await this.executeSnapshot(drive, snapshot);
    } catch (e) {
      console.error("Owen Google Drive Sync failed", e);
      this.setStatus("sync failed");
      new Notice(`Drive sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.syncing = false;
    }
  }

  private async preparePlan(drive: DriveClient): Promise<PlanSnapshot> {
    assertTargetVault(this.app.vault.getName());
    const folderName = this.settings.driveFolderName.trim() || this.app.vault.getName();
    let rootId = this.rootFolderId;
    if (rootId) await drive.verifyFolder(rootId);
    else rootId = await drive.findFolder(folderName);

    const identity = rootId ? `${this.app.vault.getName()}:${rootId}` : null;
    const firstSync =
      !this.firstSyncApproved || !identity || this.baselineIdentity !== identity;
    const baseSource = firstSync ? {} : this.base;
    const base = Object.fromEntries(
      Object.entries(baseSource).filter(([path]) => !this.excluded(path))
    );

    const mandatoryExcludedPaths = new Set<string>();
    const local: Record<string, LocalEntry> = {};
    for (const file of this.app.vault.getFiles()) {
      if (isMandatoryExcluded(file.path, this.app.vault.configDir)) {
        mandatoryExcludedPaths.add(file.path);
        continue;
      }
      if (this.excluded(file.path)) continue;
      const previous = base[file.path];
      const reusableHash =
        previous?.localHash &&
        previous.localMtime === file.stat.mtime &&
        previous.localSize === file.stat.size
          ? previous.localHash
          : null;
      local[file.path] = {
        mtime: file.stat.mtime,
        size: file.stat.size,
        hash: reusableHash ?? await sha256Hex(await this.app.vault.readBinary(file)),
      };
    }

    const remote: Record<string, RemoteEntry> = {};
    if (rootId) {
      for (const [path, file] of await drive.listTree(rootId)) {
        if (isMandatoryExcluded(path, this.app.vault.configDir)) {
          mandatoryExcludedPaths.add(path);
          continue;
        }
        if (this.excluded(path)) continue;
        remote[path] = {
          fileId: file.id,
          rev: file.md5Checksum ?? file.modifiedTime ?? "",
          size: Number(file.size ?? 0),
          mtime: file.modifiedTime ? Date.parse(file.modifiedTime) : undefined,
        };
      }
    }

    const actions = planSync(base, local, remote);
    const safety = assessPlanSafety(
      actions,
      Object.keys(base).length,
      Object.keys(remote).length,
      firstSync
    );
    const warnings = [...safety.warnings];
    if (mandatoryExcludedPaths.size > 0) {
      const count = mandatoryExcludedPaths.size;
      warnings.push(
        `${count} ${count === 1 ? "file was" : "files were"} omitted by mandatory exclusion rules.`
      );
    }
    if (this.journal) warnings.push("A previous run was interrupted; this plan was rebuilt from current state.");
    const fingerprint = [
      identity ?? `new:${folderName}`,
      actionFingerprint(actions),
      JSON.stringify(Object.entries(local).sort()),
      JSON.stringify(Object.entries(remote).sort()),
    ].join("\n---\n");
    return {
      rootId,
      identity,
      base,
      local,
      remote,
      actions,
      fingerprint,
      firstSync,
      warnings,
      requiresApproval: safety.requiresApproval || this.journal !== null,
    };
  }

  private showPreview(snapshot: PlanSnapshot) {
    new SyncPreviewModal(this.app, snapshot, () => {
      void this.syncNow(false, "manual", snapshot.fingerprint);
    }).open();
  }

  private async executeSnapshot(drive: DriveClient, snapshot: PlanSnapshot) {
    const folderName = this.settings.driveFolderName.trim() || this.app.vault.getName();
    const rootId = snapshot.rootId ?? (await drive.ensureFolder(folderName));
    await drive.verifyFolder(rootId);
    this.rootFolderId = rootId;
    const identity = `${this.app.vault.getName()}:${rootId}`;
    this.base = snapshot.base;
    this.journal = { identity, fingerprint: snapshot.fingerprint, startedAt: Date.now() };
    await this.persist();

    const folderCache = new Map<string, string>();
    let done = 0;
    let conflictsPreserved = 0;
    const { transfers, serial, deletes } = partitionActions(snapshot.actions);

    for (const action of transfers) {
      if (action.kind === "uploadNew" || action.kind === "uploadUpdate") {
        const folders = action.path.split("/");
        folders.pop();
        if (folders.length) await drive.ensurePath(rootId, folders, folderCache);
      }
    }

    const runAction = async (action: ReturnType<typeof planSync>[number]) => {
      this.setStatus(`syncing ${++done}/${snapshot.actions.length}…`);
      await this.execute(
        drive,
        action,
        folderCache,
        snapshot.remote,
        snapshot.local,
        () => conflictsPreserved++
      );
      await this.persist();
    };

    for (const action of serial) await runAction(action);

    const queue = [...transfers];
    let firstFailure: unknown = null;
    const worker = async () => {
      while (firstFailure === null) {
        const action = queue.shift();
        if (!action) return;
        try {
          await runAction(action);
        } catch (error) {
          if (firstFailure === null) firstFailure = error;
        }
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(TRANSFER_CONCURRENCY, queue.length) }, worker)
    );
    if (firstFailure) {
      throw firstFailure instanceof Error
        ? firstFailure
        : new Error("A transfer worker failed without an Error object.");
    }

    // Destructive effects are last, after all preservation/transfers succeeded.
    for (const action of deletes) await runAction(action);

    await this.rebuildBase(drive);
    this.baselineIdentity = identity;
    this.firstSyncApproved = true;
    this.journal = null;
    await this.persist();
    this.setStatus(`synced ${new Date().toLocaleTimeString()}`);
    if (snapshot.actions.length > 0) {
      new Notice(
        `Drive sync: ${snapshot.actions.length} change(s)${
          conflictsPreserved ? `, ${conflictsPreserved} conflict(s) preserved` : ""
        }.`
      );
    }
  }

  private baseDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/base`;
  }

  private async baseSlug(path: string): Promise<string> {
    const bytes = new TextEncoder().encode(path);
    return sha256Hex(bytes.buffer);
  }

  private async basePath(path: string): Promise<string> {
    return `${this.baseDir()}/${await this.baseSlug(path)}.txt`;
  }

  private async readBaseCopy(path: string): Promise<string | null> {
    const p = await this.basePath(path);
    if (await this.app.vault.adapter.exists(p)) return this.app.vault.adapter.read(p);
    const backup = `${p}.bak`;
    if (await this.app.vault.adapter.exists(backup)) {
      const content = await this.app.vault.adapter.read(backup);
      await this.app.vault.adapter.rename(backup, p);
      return content;
    }
    return null;
  }

  private async moveBaseCopy(from: string, to: string) {
    const src = await this.basePath(from);
    if (await this.app.vault.adapter.exists(src)) {
      const content = await this.app.vault.adapter.read(src);
      await this.writeBaseCopy(to, content);
      await this.app.vault.adapter.remove(src);
    }
  }

  private async writeBaseCopy(path: string, content: string) {
    const dir = this.baseDir();
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const destination = await this.basePath(path);
    const nonce = crypto.getRandomValues(new Uint32Array(2)).join("");
    const temporary = `${destination}.${nonce}.tmp`;
    const backup = `${destination}.bak`;
    await this.app.vault.adapter.write(temporary, content);
    try {
      if (await this.app.vault.adapter.exists(backup)) {
        await this.app.vault.adapter.remove(backup);
      }
      if (await this.app.vault.adapter.exists(destination)) {
        await this.app.vault.adapter.rename(destination, backup);
      }
      await this.app.vault.adapter.rename(temporary, destination);
      if (await this.app.vault.adapter.exists(backup)) {
        await this.app.vault.adapter.remove(backup);
      }
    } catch (error) {
      if (!(await this.app.vault.adapter.exists(destination)) && await this.app.vault.adapter.exists(backup)) {
        await this.app.vault.adapter.rename(backup, destination);
      }
      if (await this.app.vault.adapter.exists(temporary)) {
        await this.app.vault.adapter.remove(temporary);
      }
      throw error;
    }
  }

  private async deleteBaseCopy(path: string) {
    const basePath = await this.basePath(path);
    const candidates = [basePath, `${basePath}.bak`];
    const dir = this.baseDir();
    if (await this.app.vault.adapter.exists(dir)) {
      const listed = await this.app.vault.adapter.list(dir);
      candidates.push(...listed.files.filter((file) => file.startsWith(`${basePath}.`)));
    }
    for (const candidate of candidates) {
      if (await this.app.vault.adapter.exists(candidate)) {
        await this.app.vault.adapter.remove(candidate);
      }
    }
  }

  private async clearBaselineFiles() {
    const dir = this.baseDir();
    if (await this.app.vault.adapter.exists(dir)) {
      await this.app.vault.adapter.rmdir(dir, true);
    }
  }

  private async assertLocalSnapshot(
    path: string,
    expected: LocalEntry | undefined,
    verifyContent = true
  ): Promise<TFile | null> {
    const current = this.app.vault.getAbstractFileByPath(path);
    if (!expected) {
      if (current) throw new Error(`${path}: local path appeared after planning.`);
      return null;
    }
    if (!(current instanceof TFile)) {
      throw new Error(`${path}: local file disappeared after planning.`);
    }
    const stat = await this.freshStat(current);
    if (
      stat.mtime !== expected.mtime ||
      (expected.size !== undefined && stat.size !== expected.size)
    ) {
      throw new Error(`${path}: local file changed after planning.`);
    }
    if (verifyContent && expected.hash) {
      const hash = await sha256Hex(await this.app.vault.readBinary(current));
      if (hash !== expected.hash) {
        throw new Error(`${path}: local file changed after planning.`);
      }
    }
    return current;
  }

  private async execute(
    drive: DriveClient,
    action: ReturnType<typeof planSync>[number],
    folderCache: Map<string, string>,
    remote: Record<string, RemoteEntry>,
    local: Record<string, LocalEntry>,
    onMerge: () => void
  ) {
    const rootId = this.rootFolderId;
    if (!rootId) throw new Error("Drive folder is not initialized yet.");
    const actionPath = "path" in action ? action.path : action.to;
    const parts = actionPath.split("/");
    const name = parts.pop();
    if (!name) return;

    switch (action.kind) {
      case "renameRemote": {
        await this.assertLocalSnapshot(action.from, local[action.from]);
        const current = await this.assertLocalSnapshot(action.to, local[action.to]);
        const toParts = action.to.split("/");
        const toName = toParts.pop();
        if (!toName) return;
        const parentId = await drive.ensurePath(rootId, toParts, folderCache);
        await this.assertLocalSnapshot(action.to, local[action.to]);
        await drive.move(
          action.fileId,
          toName,
          parentId,
          remote[action.from]?.rev
        );
        const entry = this.base[action.from];
        delete this.base[action.from];
        const f = current;
        this.base[action.to] = {
          fileId: action.fileId,
          localMtime: f instanceof TFile ? f.stat.mtime : entry?.localMtime ?? 0,
          localSize: f instanceof TFile ? f.stat.size : entry?.localSize,
          localHash: entry?.localHash,
          remoteRev: entry?.remoteRev ?? "",
        };
        await this.moveBaseCopy(action.from, action.to);
        return;
      }

      case "renameLocal": {
        const from = await this.assertLocalSnapshot(action.from, local[action.from]);
        await this.assertLocalSnapshot(action.to, local[action.to]);
        if (!(from instanceof TFile)) throw new Error(`${action.from}: rename source is missing.`);
        const toParts = action.to.split("/");
        toParts.pop();
        await this.ensureLocalFolders(toParts);
        // fileManager keeps links pointing at the renamed note.
        await this.app.fileManager.renameFile(from, normalizePath(action.to));
        const entry = this.base[action.from];
        delete this.base[action.from];
        let f = this.app.vault.getAbstractFileByPath(action.to);
        if (action.remoteChanged && f instanceof TFile) {
          const remoteEntry = remote[action.to];
          const bytes = await drive.download(
            action.fileId,
            remoteEntry?.rev,
            action.remoteSize
          );
          await this.assertLocalSnapshot(action.to, local[action.from]);
          await this.app.vault.modifyBinary(f, bytes);
          f = this.app.vault.getAbstractFileByPath(action.to);
          if (f instanceof TFile && this.isTextPath(action.to)) {
            await this.writeBaseCopy(action.to, await this.app.vault.read(f));
          }
          await this.deleteBaseCopy(action.from);
        } else {
          await this.moveBaseCopy(action.from, action.to);
        }
        const localBytes = f instanceof TFile ? await this.app.vault.readBinary(f) : null;
        const stat = f instanceof TFile ? await this.freshStat(f) : null;
        this.base[action.to] = {
          fileId: action.fileId,
          localMtime: stat?.mtime ?? 0,
          localSize: stat?.size,
          localHash: localBytes ? await sha256Hex(localBytes) : entry?.localHash,
          remoteRev: entry?.remoteRev ?? "",
        };
        return;
      }

      case "uploadNew":
      case "uploadUpdate": {
        const expected = local[action.path];
        const file = await this.assertLocalSnapshot(action.path, expected, false);
        if (!(file instanceof TFile)) throw new Error(`${action.path}: upload source is missing.`);
        const content = await this.app.vault.readBinary(file);
        const localHash = await sha256Hex(content);
        if (expected?.hash && localHash !== expected.hash) {
          throw new Error(`${action.path}: local file changed after planning.`);
        }
        const parentId = await drive.ensurePath(rootId, parts, folderCache);
        await this.assertLocalSnapshot(action.path, expected, false);
        const uploaded = await drive.upload(
          name,
          parentId,
          content,
          action.kind === "uploadUpdate" ? action.fileId : undefined,
          action.kind === "uploadUpdate" ? remote[action.path]?.rev : undefined
        );
        await this.assertLocalSnapshot(action.path, expected, false);
        const stableStat = await this.freshStat(file);
        this.base[action.path] = {
          fileId: uploaded.id,
          localMtime: stableStat.mtime,
          localSize: stableStat.size,
          localHash,
          remoteRev: uploaded.md5Checksum ?? "",
        };
        if (this.isTextPath(action.path)) {
          await this.writeBaseCopy(action.path, await this.app.vault.read(file));
        }
        return;
      }

      case "downloadNew":
      case "downloadUpdate": {
        await this.assertLocalSnapshot(action.path, local[action.path]);
        const remoteEntry = remote[action.path];
        const bytes = await drive.download(
          action.fileId,
          remoteEntry?.rev,
          remoteEntry?.size
        );
        await this.assertLocalSnapshot(action.path, local[action.path]);
        await this.ensureLocalFolders(parts);
        const existing = this.app.vault.getAbstractFileByPath(action.path);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, bytes);
        } else {
          await this.app.vault.createBinary(normalizePath(action.path), bytes);
        }
        const f = this.app.vault.getAbstractFileByPath(action.path);
        if (f instanceof TFile) {
          const st = await this.freshStat(f);
          this.base[action.path] = {
            fileId: action.fileId,
            localMtime: st.mtime,
            localSize: st.size,
            localHash: await sha256Hex(bytes),
            remoteRev: "", // filled by rebuildBase
          };
          if (this.isTextPath(action.path)) {
            await this.writeBaseCopy(action.path, await this.app.vault.read(f));
          }
        }
        return;
      }

      case "deleteLocal": {
        const file = await this.assertLocalSnapshot(action.path, local[action.path]);
        // Trashed per the user's "deleted files" preference, never silently gone.
        if (file) await this.app.fileManager.trashFile(file);
        delete this.base[action.path];
        await this.deleteBaseCopy(action.path);
        return;
      }

      case "deleteRemote": {
        await this.assertLocalSnapshot(action.path, local[action.path]);
        await drive.trash(action.fileId, remote[action.path]?.rev);
        delete this.base[action.path];
        await this.deleteBaseCopy(action.path);
        return;
      }

      case "conflict": {
        await this.resolveConflict(
          drive,
          action.path,
          action.fileId,
          folderCache,
          remote[action.path],
          local[action.path],
          onMerge
        );
        return;
      }
    }
  }

  // Both inputs always remain recoverable. Text conflicts use explicit
  // markers; binary conflicts keep the local input as a sibling copy.
  private async resolveConflict(
    drive: DriveClient,
    path: string,
    fileId: string,
    folderCache: Map<string, string>,
    remoteEntry: RemoteEntry | undefined,
    localEntry: LocalEntry | undefined,
    onMerge: () => void
  ) {
    const file = await this.assertLocalSnapshot(path, localEntry);
    if (!(file instanceof TFile)) throw new Error(`${path}: conflict source is missing.`);

    const remoteBytes = await drive.download(fileId, remoteEntry?.rev, remoteEntry?.size);
    await this.assertLocalSnapshot(path, localEntry);
    const localBytes = await this.app.vault.readBinary(file);

    // Identical bytes on both sides: adopt silently, no upload. This is what
    // makes connecting a second device that already holds the vault painless.
    if (bytesEqual(localBytes, remoteBytes)) {
      this.base[path] = {
        fileId,
        localMtime: file.stat.mtime,
        localSize: file.stat.size,
        localHash: await sha256Hex(localBytes),
        remoteRev: "", // filled by rebuildBase
      };
      if (this.isTextPath(path)) {
        await this.writeBaseCopy(path, await this.app.vault.read(file));
      }
      return;
    }

    if (this.isTextPath(path)) {
      const localText = await this.app.vault.read(file);
      const remoteText = new TextDecoder().decode(remoteBytes);
      const baseText = await this.readBaseCopy(path);
      const result = mergeTextPreservingBoth(baseText, localText, remoteText);
      if (result.preserveRemoteCopy) {
        await this.createConflictCopy(path, "Drive", remoteBytes);
      }
      await this.app.vault.modify(file, result.content);
      await this.finishConflict(
        drive,
        path,
        fileId,
        result.content,
        folderCache,
        file,
        remoteEntry?.rev
      );
      if (result.conflicts > 0) {
        onMerge();
        new Notice(
          `${path}: both versions were preserved with conflict markers and a Drive copy.`
        );
      }
      return;
    }

    await this.createConflictCopy(path, "Local", localBytes);
    await this.app.vault.modifyBinary(file, remoteBytes);
    const st = await this.freshStat(file);
    this.base[path] = {
      fileId,
      localMtime: st.mtime,
      localSize: st.size,
      localHash: await sha256Hex(remoteBytes),
      remoteRev: "", // filled by rebuildBase
    };
    onMerge();
  }

  private async createConflictCopy(
    path: string,
    source: "Drive" | "Local",
    bytes: ArrayBuffer
  ): Promise<string> {
    const digestMarker = Number.parseInt((await sha256Hex(bytes)).slice(0, 12), 16);
    for (let offset = 0; offset < 100; offset++) {
      const candidate = conflictCopyPath(path, source, digestMarker + offset);
      const existing = this.app.vault.getAbstractFileByPath(candidate);
      if (existing instanceof TFile) {
        if (bytesEqual(await this.app.vault.readBinary(existing), bytes)) return candidate;
        continue;
      }
      if (!existing) {
        const folders = candidate.split("/");
        folders.pop();
        await this.ensureLocalFolders(folders);
        await this.app.vault.createBinary(normalizePath(candidate), bytes);
        return candidate;
      }
    }
    throw new Error(`${path}: could not allocate a conflict copy name.`);
  }

  // TFile.stat refreshes asynchronously after a write, so mtime read from it
  // right after vault.modify can be stale; the disk is the truth. A stale
  // mtime in base breaks exact-match rename detection on the next sync.
  private async freshStat(file: TFile): Promise<{ mtime: number; size: number }> {
    const st = await this.app.vault.adapter.stat(file.path);
    return st ? { mtime: st.mtime, size: st.size } : file.stat;
  }

  private async finishConflict(
    drive: DriveClient,
    path: string,
    fileId: string,
    content: string,
    folderCache: Map<string, string>,
    file: TFile,
    expectedRemoteRevision: string | undefined
  ) {
    const parts = path.split("/");
    const name = parts.pop();
    const rootId = this.rootFolderId;
    if (!name || !rootId) return;
    const parentId = await drive.ensurePath(rootId, parts, folderCache);
    const bytes = new TextEncoder().encode(content);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const up = await drive.upload(
      name,
      parentId,
      body,
      fileId,
      expectedRemoteRevision
    );
    const st = await this.freshStat(file);
    this.base[path] = {
      fileId: up.id,
      localMtime: st.mtime,
      localSize: st.size,
      localHash: await sha256Hex(body),
      remoteRev: up.md5Checksum ?? "",
    };
    await this.writeBaseCopy(path, content);
  }

  private async ensureLocalFolders(parts: string[]) {
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(acc)) {
        await this.app.vault.createFolder(acc).catch(() => undefined);
      }
    }
  }

  // After executing, re-list the remote so base holds true revisions.
  private async rebuildBase(drive: DriveClient) {
    const rootId = this.rootFolderId;
    if (!rootId) return;
    const remoteTree = await drive.listTree(rootId);
    for (const [path, f] of remoteTree) {
      if (this.excluded(path)) continue;
      const entry = this.base[path];
      if (entry) {
        entry.fileId = f.id;
        entry.remoteRev = f.md5Checksum ?? f.modifiedTime ?? "";
      }
    }
    for (const path of Object.keys(this.base)) {
      if (!remoteTree.has(path) || this.excluded(path)) {
        delete this.base[path];
        await this.deleteBaseCopy(path);
      }
    }
  }
}

class BaselineResetModal extends Modal {
  constructor(app: App, private reset: () => void) {
    super(app);
  }

  onOpen() {
    this.setTitle("Reset sync baseline");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "This keeps the Google connection but forgets the current folder and last-common baseline. The next sync is a read-only first-sync preview.",
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText("Reset baseline");
        button.onClick(() => {
          this.close();
          this.reset();
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SyncPreviewModal extends Modal {
  constructor(
    app: App,
    private snapshot: PlanSnapshot,
    private approve: () => void
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle("Review Google Drive sync");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: `${this.snapshot.actions.length} action(s). Nothing changes until you approve.`,
    });
    for (const warning of this.snapshot.warnings) {
      contentEl.createEl("p", { text: warning, cls: "ogds-preview-warning" });
    }
    const list = contentEl.createDiv({ cls: "ogds-preview-list" });
    if (this.snapshot.actions.length === 0) {
      list.createDiv({ text: "Nothing to transfer. Approval records this as the first common baseline." });
    } else {
      for (const action of this.snapshot.actions) {
        list.createDiv({ text: describeAction(action) });
      }
    }
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Approve and sync")
          .setCta()
          .onClick(() => {
            this.close();
            this.approve();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConnectionTransferModal extends Modal {
  private passphrase = "";
  private code = "";

  constructor(private plugin: DriveMergeSyncPlugin) {
    super(plugin.app);
  }

  onOpen() {
    this.setTitle("Encrypted device transfer");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "Use a passphrase of at least 12 characters on both devices. Codes expire after 15 minutes and do not contain an access token.",
    });
    new Setting(contentEl).setName("Transfer passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("12+ characters").onChange((value) => {
        this.passphrase = value;
      });
    });
    let displayCode = (_value: string) => undefined;
    new Setting(contentEl).setName("Connection code").addTextArea((area) => {
      displayCode = (value) => {
        area.setValue(value);
      };
      area.setPlaceholder("Encrypted code").onChange((value) => {
        this.code = value;
      });
      area.inputEl.rows = 5;
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Copy new code").onClick(async () => {
          try {
            const code = await this.plugin.exportConnectionCode(this.passphrase);
            if (!code) {
              new Notice("Connect Google Drive first.");
              return;
            }
            this.code = code;
            const copied = await presentConnectionCode(
              code,
              displayCode,
              navigator.clipboard?.writeText
                ? (value) => navigator.clipboard.writeText(value)
                : undefined
            );
            new Notice(
              copied
                ? "Encrypted connection code copied. It expires in 15 minutes."
                : "Encrypted connection code is shown above, but clipboard copy was unavailable."
            );
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        })
      )
      .addButton((button) =>
        button.setButtonText("Import code").setCta().onClick(async () => {
          const ok = await this.plugin.importConnectionCode(this.code, this.passphrase);
          new Notice(ok ? "Connection imported. Preview the first sync next." : "Code, passphrase, or expiry is invalid.");
          if (ok) this.close();
        })
      );
  }

  onClose() {
    this.passphrase = "";
    this.code = "";
    this.contentEl.empty();
  }
}

// ---- Settings ---------------------------------------------------------------

class DriveMergeSettingTab extends PluginSettingTab {
  plugin: DriveMergeSyncPlugin;

  constructor(plugin: DriveMergeSyncPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Set up")
      .setDesc("The wizard walks through the one-time Google setup: four links, one paste, one sign-in.")
      .addButton((b) =>
        b.setButtonText("Open setup wizard").setCta().onClick(() => new ConnectWizard(this.plugin).open())
      );

    new Setting(containerEl)
      .setName("Google client ID")
      .setDesc(
        "Filled automatically by the wizard; edit only if you manage credentials by hand. They stay on this machine."
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.clientId).onChange(async (v) => {
          this.plugin.settings.clientId = v.trim();
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Google client secret")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.clientSecret).onChange(async (v) => {
          this.plugin.settings.clientSecret = v.trim();
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("Connect")
      .setDesc(
        "Opens Google sign-in on desktop. Disconnect revokes the shared refresh token and clears local credentials and baseline state."
      )
      .addButton((b) =>
        b.setButtonText("Connect Google Drive").setCta().onClick(() => void this.plugin.connect())
      )
      .addButton((b) =>
        b.setButtonText("Disconnect").onClick(async () => {
          await this.plugin.disconnect();
          new Notice("Disconnected.");
        })
      );

    new Setting(containerEl)
      .setName("Encrypted device transfer")
      .setDesc(
        "Create or import a 15-minute encrypted connection code. The passphrase and code are never saved."
      )
      .addButton((b) =>
        b.setButtonText("Open transfer dialog").onClick(() => {
          new ConnectionTransferModal(this.plugin).open();
        })
      );

    new Setting(containerEl)
      .setName("Drive folder name")
      .setDesc("Name of the sync folder in your drive; leave empty to use the vault's name.")
      .addText((t) =>
        t.setValue(this.plugin.settings.driveFolderName).onChange(async (v) => {
          this.plugin.settings.driveFolderName = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc(
        "Run after Obsidian opens. Resume and debounced edit syncs also run only while Obsidian is visible; iOS background sync is not supported."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
          this.plugin.settings.syncOnStartup = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc(
        "One per line. Mandatory exclusions for Obsidian state, auth data, trash, Git, raw archives, build output, and secret files always apply."
      )
      .addTextArea((ta) =>
        ta
          .setValue(this.plugin.settings.excludedFolders.join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.excludedFolders = v
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.persist();
          })
      );
  }
}
