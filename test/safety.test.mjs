import { strict as assert } from "node:assert";
import {
  assessPlanSafety,
  assertSafeRemoteName,
  assertSafeRemotePath,
  assertTargetVault,
  conflictCopyPath,
  isMandatoryExcluded,
  partitionActions,
} from "./safety.build.mjs";

for (const path of [
  ".obsidian/plugins/owen-google-drive-sync/data.json",
  ".obsidian/workspace.json",
  ".trash/deleted.md",
  ".mobile-sync-trash/deleted.md",
  ".git/config",
  "owen-raw/export.json",
  "archives/vault.zip",
  "dist/main.js",
  "output/report.json",
  "60-studio/20-draft/private.md",
  ".DS_Store",
  ".env.production",
  ".envrc",
  "keys/private.pem",
  "client_secret_test.json",
  "RCLONE_TEST",
]) {
  assert.equal(isMandatoryExcluded(path, ".obsidian"), true, `${path} must be excluded`);
}
assert.equal(isMandatoryExcluded("notes/daily.md", ".obsidian"), false);
// Root rule files sync like any other note since 2.2.1 (one vault, one rulebook).
assert.equal(isMandatoryExcluded("AGENTS.md", ".obsidian"), false);
assert.equal(isMandatoryExcluded("CLAUDE.md", ".obsidian"), false);
assert.doesNotThrow(() => assertTargetVault("owen-mobile"));
assert.doesNotThrow(() => assertTargetVault("owen-brain"));
assert.throws(() => assertTargetVault("other-vault"), /only syncs/);
assert.doesNotThrow(() => assertSafeRemotePath("notes/daily.md"));
assert.doesNotThrow(() => assertSafeRemoteName("daily.md"));
for (const name of ["", ".", "..", "nested/name.md", "a\\b.md", "bad\u0000name"] ) {
  assert.throws(() => assertSafeRemoteName(name), /Unsafe R2 item name/);
}
for (const path of ["../escape.md", "/absolute.md", "a\\b.md", "a//b.md"]) {
  assert.throws(() => assertSafeRemotePath(path), /Unsafe R2 path/);
}

const first = assessPlanSafety([{ kind: "uploadNew", path: "a.md" }], 0, 0, true);
assert.equal(first.requiresApproval, true);
assert.throws(
  () => assessPlanSafety([{ kind: "deleteLocal", path: "a.md" }], 1, 0, false),
  /unexpectedly empty/
);
const mass = assessPlanSafety(
  Array.from({ length: 20 }, (_, index) => ({ kind: "deleteLocal", path: `${index}.md` })),
  100,
  80,
  false
);
assert.equal(mass.requiresApproval, false);
assert.match(mass.warnings.join(" "), /applied automatically/);
assert.equal(
  assessPlanSafety([{ kind: "deleteLocal", path: "one.md" }], 5, 4, false)
    .requiresApproval,
  false
);
assert.equal(
  assessPlanSafety(
    [
      { kind: "deleteLocal", path: "one.md" },
      { kind: "deleteLocal", path: "two.md" },
      { kind: "deleteLocal", path: "three.md" },
    ],
    1000,
    997,
    false
  ).requiresApproval,
  false
);

const partitioned = partitionActions([
  { kind: "deleteRemote", path: "gone.md", fileId: "gone" },
  { kind: "uploadNew", path: "new.md" },
  { kind: "conflict", path: "same.md", fileId: "same" },
]);
assert.deepEqual(partitioned.transfers.map((action) => action.kind), ["uploadNew"]);
assert.deepEqual(partitioned.serial.map((action) => action.kind), ["conflict"]);
assert.deepEqual(partitioned.deletes.map((action) => action.kind), ["deleteRemote"]);
assert.equal(conflictCopyPath("notes/a.md", "R2", 123), "notes/a (R2 conflict 123).md");

console.log("safety: exclusions, approval gates, and destructive ordering passed");
