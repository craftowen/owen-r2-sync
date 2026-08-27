import { strict as assert } from "node:assert";
import { mergeTextPreservingBoth } from "./conflict.build.mjs";

const noBase = mergeTextPreservingBoth(null, "local only", "remote only");
assert.equal(noBase.preserveRemoteCopy, true);
assert.match(noBase.content, /local only/);
assert.match(noBase.content, /remote only/);

const overlap = mergeTextPreservingBoth("same", "local", "remote");
assert.equal(overlap.preserveRemoteCopy, true);
assert.match(overlap.content, /^<<<<<<< LOCAL/);

const disjoint = mergeTextPreservingBoth("a\nb", "a\nB", "A\nb");
assert.equal(disjoint.conflicts, 0);
assert.equal(disjoint.content, "A\nB");

console.log("conflict: missing baseline, true conflicts, and disjoint merge preservation passed");
