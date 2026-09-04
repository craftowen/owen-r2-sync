import type { SyncAction } from "./planner";

const BLOCKED_SEGMENTS = new Set([
  ".trash",
  ".mobile-sync-trash",
  ".git",
  "node_modules",
  "build",
  "dist",
  "out",
  ".output",
  "output",
  ".next",
  "coverage",
  "raw",
  "archive",
  "archives",
  "owen-raw",
  "60-studio",
]);

const ARCHIVE_EXTENSIONS = [".7z", ".gz", ".rar", ".tar", ".tgz", ".zip"];
const SECRET_EXTENSIONS = [".key", ".p12", ".pem", ".pfx"];
export const TARGET_VAULTS = new Set(["owen-brain", "owen-mobile"]);

function pathParts(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

/** Hard exclusions cannot be disabled in settings. */
export function isMandatoryExcluded(path: string, configDir: string): boolean {
  const parts = pathParts(path);
  const lower = parts.map((part) => part.toLocaleLowerCase());
  if (lower[0] === configDir.toLocaleLowerCase()) return true;
  if (lower.some((part) => BLOCKED_SEGMENTS.has(part))) return true;

  const name = lower[lower.length - 1] ?? "";
  if (!name) return true;
  if (name === ".ds_store") return true;
  if (parts.length === 1 && name === "rclone_test") return true;
  if (name === "data.json" || name === "credentials.json") return true;
  if (name === ".env" || name.startsWith(".env.") || name === ".envrc") return true;
  if (name.startsWith("client_secret") || name.includes("connection-code")) return true;
  if (name === "workspace" || name.startsWith("workspace.json")) return true;
  if (ARCHIVE_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  if (SECRET_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  return false;
}

/** Validate one remote item name before joining it into a vault-relative path. */
export function assertSafeRemoteName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /\p{Cc}/u.test(name)
  ) {
    throw new Error(`Unsafe R2 item name: ${JSON.stringify(name)}`);
  }
}

/** Remote names are untrusted input. Invalid paths stop the run instead of escaping the vault. */
export function assertSafeRemotePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.length > 1024) {
    throw new Error(`Unsafe R2 path: ${JSON.stringify(path)}`);
  }
  if (/\p{Cc}/u.test(path)) {
    throw new Error(`R2 path contains control characters: ${JSON.stringify(path)}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe R2 path segment: ${JSON.stringify(path)}`);
  }
}

export function assertTargetVault(vaultName: string): void {
  if (!TARGET_VAULTS.has(vaultName)) {
    throw new Error(
      `This private plugin only syncs Owen's brain/mobile vaults; current vault is '${vaultName}'.`
    );
  }
}

export function hashBytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", bytes);
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await hashBytes(bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function describeAction(action: SyncAction): string {
  return "path" in action
    ? `${action.kind}: ${action.path}`
    : `${action.kind}: ${action.from} -> ${action.to}`;
}

export function actionFingerprint(actions: SyncAction[]): string {
  return actions.map(describeAction).sort().join("\n");
}

export interface PlanSafety {
  requiresApproval: boolean;
  warnings: string[];
}

export function assessPlanSafety(
  actions: SyncAction[],
  baseCount: number,
  remoteCount: number,
  firstSync: boolean
): PlanSafety {
  const deletes = actions.filter(
    (action) => action.kind === "deleteLocal" || action.kind === "deleteRemote"
  ).length;

  if (baseCount > 0 && remoteCount === 0 && actions.some((a) => a.kind === "deleteLocal")) {
    throw new Error(
      "R2 namespace is unexpectedly empty while a sync baseline exists. No local files were changed."
    );
  }

  const warnings: string[] = [];
  if (firstSync) warnings.push("First sync: review every action before approving.");
  const deleteRatio = deletes / Math.max(1, baseCount);
  // Deletes and conflicts sync unattended: every replaced or deleted revision is
  // archived in immutable R2 history, and conflicts preserve both versions.
  // Only the first sync (or a changed vault/worker identity) needs a human.
  if (deletes >= 3 || (deletes >= 2 && deleteRatio > 0.1)) {
    warnings.push(`${deletes} ${deletes === 1 ? "delete" : "deletes"} applied automatically (R2 history keeps prior versions).`);
  }
  if (actions.some((action) => action.kind === "conflict")) {
    warnings.push("Both-changed files will preserve both versions.");
  }
  return { requiresApproval: firstSync, warnings };
}

export function partitionActions(actions: SyncAction[]): {
  transfers: SyncAction[];
  serial: SyncAction[];
  deletes: SyncAction[];
} {
  const deletes = actions.filter(
    (action) => action.kind === "deleteLocal" || action.kind === "deleteRemote"
  );
  const deleteSet = new Set<SyncAction>(deletes);
  const transfers = actions.filter(
    (action) =>
      !deleteSet.has(action) &&
      (action.kind.startsWith("upload") || action.kind.startsWith("download"))
  );
  const transferSet = new Set<SyncAction>(transfers);
  const serial = actions.filter(
    (action) => !deleteSet.has(action) && !transferSet.has(action)
  );
  return { transfers, serial, deletes };
}

export function conflictCopyPath(
  path: string,
  source: "R2" | "Local",
  timestamp: number
): string {
  return path.replace(/(\.[^./]+)?$/, ` (${source} conflict ${timestamp})$1`);
}
