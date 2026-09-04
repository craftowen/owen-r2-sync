import { merge3 } from "./merge";

export interface PreservedTextMerge {
  content: string;
  conflicts: number;
  preserveRemoteCopy: boolean;
}

export function mergeTextPreservingBoth(
  base: string | null,
  local: string,
  remote: string
): PreservedTextMerge {
  const result = base === null ? { merged: "", conflicts: 1 } : merge3(base, local, remote);
  if (result.conflicts === 0) {
    return { content: result.merged, conflicts: 0, preserveRemoteCopy: false };
  }
  return {
    content: `<<<<<<< LOCAL\n${local}\n=======\n${remote}\n>>>>>>> CLOUDFLARE R2\n`,
    conflicts: result.conflicts,
    preserveRemoteCopy: true,
  };
}
