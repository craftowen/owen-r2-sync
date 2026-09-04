import { strict as assert } from "node:assert";
import { mergeTextPreservingBoth } from "./conflict.build.mjs";

// No common baseline: the newer side is canonical, the other becomes a copy.
const noBaseLocalNewer = mergeTextPreservingBoth(null, "local only", "remote only", true);
assert.equal(noBaseLocalNewer.content, "local only");
assert.equal(noBaseLocalNewer.preserveCopy, "R2");
assert.equal(noBaseLocalNewer.winner, "local");
const noBaseRemoteNewer = mergeTextPreservingBoth(null, "local only", "remote only", false);
assert.equal(noBaseRemoteNewer.content, "remote only");
assert.equal(noBaseRemoteNewer.preserveCopy, "Local");
assert.equal(noBaseRemoteNewer.winner, "remote");

// True line collision: no markers ever land in the canonical note.
const overlap = mergeTextPreservingBoth("same", "local", "remote", true);
assert.equal(overlap.content, "local");
assert.equal(overlap.preserveCopy, "R2");
assert.doesNotMatch(overlap.content, /<<<<<<<|>>>>>>>/);

// Disjoint edits still merge cleanly with nothing to preserve.
const disjoint = mergeTextPreservingBoth("a\nb", "a\nB", "A\nb");
assert.equal(disjoint.conflicts, 0);
assert.equal(disjoint.content, "A\nB");
assert.equal(disjoint.preserveCopy, null);

console.log("conflict: missing baseline, newer-wins collisions without markers, and disjoint merge passed");
