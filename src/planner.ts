// The sync brain: a pure three-way diff between the last agreed state (base),
// the local vault, and the remote Drive folder. No I/O, fully testable.
//
// The rules protect data the way a careful human would:
// - changed on one side only: carry the change to the other side
// - changed on both sides: a conflict, resolved by merge (text) or kept safe
// - deleted on one side, untouched on the other: delete travels
// - deleted on one side, CHANGED on the other: the change wins, deletion loses

export interface BaseEntry {
  fileId: string;
  localMtime: number;
  localSize?: number;
  localHash?: string;
  remoteRev: string; // md5 checksum or version marker from Drive
}

export interface LocalEntry {
  mtime: number;
  size: number;
  hash?: string;
}

export interface RemoteEntry {
  fileId: string;
  rev: string;
  size: number;
  mtime?: number; // epoch ms, when Drive reported modifiedTime
}

export type SyncAction =
  | { kind: "renameRemote"; from: string; to: string; fileId: string }
  | {
      kind: "renameLocal";
      from: string;
      to: string;
      fileId: string;
      remoteChanged?: boolean;
      remoteSize?: number;
    }
  | { kind: "uploadNew"; path: string }
  | { kind: "uploadUpdate"; path: string; fileId: string }
  | { kind: "downloadNew"; path: string; fileId: string }
  | { kind: "downloadUpdate"; path: string; fileId: string }
  | { kind: "deleteRemote"; path: string; fileId: string }
  | { kind: "deleteLocal"; path: string }
  | { kind: "conflict"; path: string; fileId: string };

export function planSync(
  base: Record<string, BaseEntry>,
  local: Record<string, LocalEntry>,
  remote: Record<string, RemoteEntry>
): SyncAction[] {
  const actions: SyncAction[] = [];
  const paths = new Set<string>([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  for (const path of [...paths].sort()) {
    const b = base[path];
    const l = local[path];
    const r = remote[path];

    const localChanged = !!(
      l &&
      (!b ||
        (b.localHash && l.hash
          ? b.localHash !== l.hash
          : l.mtime !== b.localMtime ||
            (b.localSize !== undefined && l.size !== b.localSize)))
    );
    const remoteChanged = !!(r && (!b || r.rev !== b.remoteRev));

    if (l && r) {
      if (!b) {
        // Same path appeared independently on both sides: treat as conflict
        // unless we can prove equality later at execution time.
        actions.push({ kind: "conflict", path, fileId: r.fileId });
      } else if (localChanged && remoteChanged) {
        actions.push({ kind: "conflict", path, fileId: r.fileId });
      } else if (localChanged) {
        actions.push({ kind: "uploadUpdate", path, fileId: r.fileId });
      } else if (remoteChanged) {
        actions.push({ kind: "downloadUpdate", path, fileId: r.fileId });
      }
      continue;
    }

    if (l && !r) {
      if (!b) {
        actions.push({ kind: "uploadNew", path });
      } else if (localChanged) {
        // Deleted remotely but edited locally afterwards: the edit wins.
        actions.push({ kind: "uploadNew", path });
      } else {
        actions.push({ kind: "deleteLocal", path });
      }
      continue;
    }

    if (!l && r) {
      if (!b) {
        actions.push({ kind: "downloadNew", path, fileId: r.fileId });
      } else if (remoteChanged) {
        // Deleted locally but edited remotely afterwards: the edit wins.
        actions.push({ kind: "downloadNew", path, fileId: r.fileId });
      } else {
        actions.push({ kind: "deleteRemote", path, fileId: r.fileId });
      }
      continue;
    }

    // Only in base: both sides deleted it independently. Nothing to do; the
    // executor drops the base entry.
  }

  return detectRenames(base, local, remote, actions);
}

// A rename shows up as a delete on one side plus a create with identical
// content identity. Pairing them preserves links and history; pairing is only
// done when the match is unique, otherwise the safe delete-plus-create stands.
function detectRenames(
  base: Record<string, BaseEntry>,
  local: Record<string, LocalEntry>,
  remote: Record<string, RemoteEntry>,
  actions: SyncAction[]
): SyncAction[] {
  const out: SyncAction[] = [];
  const consumed = new Set<SyncAction>();

  const deleteRemotes = actions.filter(
    (a): a is Extract<SyncAction, { kind: "deleteRemote" }> => a.kind === "deleteRemote"
  );
  const uploadNews = actions.filter(
    (a): a is Extract<SyncAction, { kind: "uploadNew" }> =>
      a.kind === "uploadNew" && !base[a.path]
  );
  const deleteLocals = actions.filter(
    (a): a is Extract<SyncAction, { kind: "deleteLocal" }> => a.kind === "deleteLocal"
  );
  const downloadNews = actions.filter(
    (a): a is Extract<SyncAction, { kind: "downloadNew" }> =>
      a.kind === "downloadNew" && !base[a.path]
  );

  // Local rename: prefer the persisted content hash. The size/mtime fallback
  // only migrates legacy baselines that predate hashes.
  for (const del of deleteRemotes) {
    const b = base[del.path];
    if (!b || b.localSize === undefined) continue;
    const matches = uploadNews.filter(
      (u) =>
        !consumed.has(u) &&
        local[u.path] &&
        (b.localHash && local[u.path].hash
          ? local[u.path].hash === b.localHash
          : local[u.path].size === b.localSize &&
            local[u.path].mtime === b.localMtime)
    );
    if (matches.length === 1) {
      consumed.add(del);
      consumed.add(matches[0]);
      out.push({ kind: "renameRemote", from: del.path, to: matches[0].path, fileId: del.fileId });
    }
  }

  // Remote rename: Drive file IDs are stable across rename and move. Matching
  // on checksum can misidentify a different same-content file.
  for (const del of deleteLocals) {
    const b = base[del.path];
    if (!b?.fileId) continue;
    const matches = downloadNews.filter(
      (d) =>
        !consumed.has(d) &&
        remote[d.path] &&
        remote[d.path].fileId === b.fileId
    );
    if (matches.length === 1) {
      const remoteEntry = remote[matches[0].path];
      consumed.add(del);
      consumed.add(matches[0]);
      out.push({
        kind: "renameLocal",
        from: del.path,
        to: matches[0].path,
        fileId: matches[0].fileId,
        ...(remoteEntry.rev !== b.remoteRev
          ? { remoteChanged: true, remoteSize: remoteEntry.size }
          : {}),
      });
    }
  }

  for (const a of actions) if (!consumed.has(a)) out.push(a);
  return out;
}
