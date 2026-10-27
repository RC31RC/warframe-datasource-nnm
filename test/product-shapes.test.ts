import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProductShapes } from "../src/analysis/product-shapes.js";

test("distinguishes nullable optional columns from incompatible JSON field types", () => {
  const result = analyzeProductShapes([{ name: "A", description: null }, { name: "B", description: "text", icon: "url" }], "items/resources.json");
  assert.deepEqual(result.mixedTypes, []);
  assert.deepEqual(result.varyingFieldSets[0]?.optionalFields, ["icon"]);
  assert.deepEqual(analyzeProductShapes([{ description: ["text"] }, { description: "text" }], "items/resources.json").mixedTypes,
    [{ path: "$.description", types: ["array", "string"] }]);
});
test("audits records inside keyed maps instead of treating IDs as columns", () => {
  const result = analyzeProductShapes({ agents: { A: { avatarTypes: { STANDARD: "/A", itemReferences: [] } }, B: { avatarTypes: { EXIMUS: "/B" } } } }, "world/enemies.json");
  assert.deepEqual(result.mixedTypes, [{ path: "$.agents{}.avatarTypes{}", types: ["array", "string"] }]);
});
