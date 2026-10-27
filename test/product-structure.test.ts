import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProductStructure } from "../src/analysis/product-structure.js";
import { compactProductValue } from "../src/projections/compact.js";

test("counts sibling collections separately; singular chains merge and promote child collections", () => {
  const input = [{ id: "a", b: [{ id: "b1" }], media: { title: "c", item: { name: "d" }, images: [{ url: "e" }] } }];
  const before = analyzeProductStructure(input, "equipment/warframes.json");
  const after = analyzeProductStructure(compactProductValue(input, "equipment/warframes.json"), "equipment/warframes.json");
  assert.deepEqual(before.tablePaths, ["$", "b", "media", "media.images", "media.item"]);
  assert.deepEqual(after.tablePaths, ["$", "b", "media__images"]);
  assert.equal(before.recordDepth, 3); assert.equal(after.recordDepth, 2);
  assert.equal(before.scalarLeaves, after.scalarLeaves); assert.equal(before.arrays, after.arrays);
});
test("recursive groups share one parent-linked table, regardless of nesting depth", () => {
  const input = { contexts: [{ groups: [{ groups: [{ groups: [{ rewards: [{ name: "x" }] }] }] }] }] };
  const stats = analyzeProductStructure(input, "rewards/drop-tables.json");
  assert.deepEqual(stats.tablePaths, ["$", "contexts", "contexts.groups", "contexts.groups.rewards"]);
  assert.equal(stats.recordDepth, 6);
});
test("keyed namespaces do not create a table for every dynamic definition key", () => {
  const input = { conquests: { missionVariants: { LabConquest: { A: { name: "a" }, B: { name: "b" } }, HexConquest: { C: { name: "c" } } } } };
  const stats = analyzeProductStructure(compactProductValue(input, "worldstate/activities.json"), "worldstate/activities.json");
  assert.deepEqual(stats.tablePaths, ["$", "conquests__missionVariants", "conquests__missionVariants.variants"]);
});
test("counts primitive arrays and empty collection contracts, but not empty optional single objects", () => {
  const stats = analyzeProductStructure([{ tags: ["a", "b"], children: [], media: {} }], "equipment/gear.json");
  assert.deepEqual(stats.tablePaths, ["$", "children", "tags"]);
});
