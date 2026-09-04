import { merge3 } from "./merge";

export type ConflictCopySide = "R2" | "Local";

export interface PreservedTextMerge {
  content: string;
  conflicts: number;
  /** Which side must be kept as a sibling copy; null when the merge was clean. */
  preserveCopy: ConflictCopySide | null;
  winner: "merged" | "local" | "remote";
}

// Conflict policy: try a clean three-way merge first. When lines truly collide
// (or there is no common baseline), never write conflict markers into the
// canonical note — a note full of <<<<<<< markers is unreadable on every device
// and Obsidian renders it as garbage. Instead the more recently modified side
// becomes the canonical note and the older side is preserved beside it as a
// "(R2 conflict …)" / "(Local conflict …)" sibling copy, which syncs everywhere
// so it can be reviewed and deleted from any device.
export function mergeTextPreservingBoth(
  base: string | null,
  local: string,
  remote: string,
  localIsNewer = true
): PreservedTextMerge {
  const result = base === null ? { merged: "", conflicts: 1 } : merge3(base, local, remote);
  if (result.conflicts === 0) {
    return { content: result.merged, conflicts: 0, preserveCopy: null, winner: "merged" };
  }
  if (localIsNewer) {
    return { content: local, conflicts: result.conflicts, preserveCopy: "R2", winner: "local" };
  }
  return { content: remote, conflicts: result.conflicts, preserveCopy: "Local", winner: "remote" };
}
