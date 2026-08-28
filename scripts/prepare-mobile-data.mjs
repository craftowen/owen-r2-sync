import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const [vaultArg, outputArg] = process.argv.slice(2);
if (!vaultArg || !outputArg) {
  throw new Error("usage: node scripts/prepare-mobile-data.mjs <vault> <data.json>");
}

const vault = resolve(vaultArg);
const output = resolve(outputArg);

function rcloneJson(args) {
  return JSON.parse(
    execFileSync("/opt/homebrew/bin/rclone", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  );
}

const config = rcloneJson(["config", "dump"]);
const remoteConfig = config["owen-gdrive"];
const token = JSON.parse(remoteConfig?.token ?? "null");
if (!token?.refresh_token) throw new Error("rclone OAuth token has no refresh token.");
if (!remoteConfig?.client_id || !remoteConfig?.client_secret) {
  throw new Error("rclone config has no OAuth client credentials.");
}
const clientSecret = execFileSync(
  "/opt/homebrew/bin/rclone",
  ["reveal", remoteConfig.client_secret],
  { encoding: "utf8" }
).trim();
if (!clientSecret) throw new Error("rclone OAuth client secret could not be revealed.");

const roots = rcloneJson(["lsjson", "owen-gdrive:", "--dirs-only", "--metadata"]);
const root = roots.find((entry) => entry.Path === "owen-mobile");
if (!root?.ID) throw new Error("Google Drive owen-mobile folder was not found.");

const remote = rcloneJson([
  "lsjson",
  "owen-gdrive:owen-mobile",
  "--recursive",
  "--files-only",
  "--metadata",
  "--hash",
]);
const base = {};
for (const entry of remote) {
  if (entry.Path === "RCLONE_TEST") continue;
  const path = entry.Path.normalize("NFC");
  const local = resolve(vault, path);
  if (relative(vault, local).startsWith("..")) throw new Error(`unsafe remote path: ${path}`);
  const info = await stat(local);
  if (!info.isFile() || info.size !== entry.Size) throw new Error(`local mismatch: ${path}`);
  const hash = createHash("sha256").update(await readFile(local)).digest("hex");
  if (entry.Hashes?.sha256 && hash !== entry.Hashes.sha256) {
    throw new Error(`SHA-256 mismatch: ${path}`);
  }
  if (!entry.ID) throw new Error(`Drive file ID missing: ${path}`);
  base[path] = {
    fileId: entry.ID,
    localMtime: info.mtimeMs,
    localSize: info.size,
    localHash: hash,
    remoteRev: entry.Hashes?.md5 ?? entry.ModTime ?? "",
  };
}

const data = {
  settings: {
    clientId: remoteConfig.client_id,
    clientSecret,
    driveFolderName: "owen-mobile",
    syncOnStartup: true,
    excludedFolders: [],
  },
  tokens: { accessToken: "", refreshToken: token.refresh_token, expiresAt: 0 },
  rootFolderId: root.ID,
  base,
  baselineIdentity: `owen-mobile:${root.ID}`,
  firstSyncApproved: true,
  journal: null,
};

await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, output);
console.log(JSON.stringify({ ok: true, baselineFiles: Object.keys(base).length }));
