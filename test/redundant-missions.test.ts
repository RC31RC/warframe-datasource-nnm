import test from "node:test";
import assert from "node:assert/strict";
import { previewRedundantMissions } from "../src/analysis/redundant-missions.js";

test("only previews removal when enriched missions retain every original key and value", () => {
  const input = { A: { missions: { MT_A: { level: 0, enemies: ["a", "b"] } }, missionDefinitions: [{ missionType: "MT_A", level: 0, enemies: ["a", "b"], nameZh: "任务" }] } };
  const result = previewRedundantMissions(input);
  assert.equal(result.checked, 1); assert.equal(result.removable, 1);
  assert.deepEqual(result.value, { A: { missionDefinitions: input.A.missionDefinitions } });
  assert.ok(input.A.missions); // Input and production data are not mutated.
});
test("does not omit ambiguous, partial, changed or additional source missions", () => {
  for (const definitions of [[], [{ missionType: "MT_A", level: 1 }], [{ missionType: "MT_A", level: 0 }, { missionType: "MT_A", level: 0 }]]) {
    const input = { A: { missions: { MT_A: { level: 0 } }, missionDefinitions: definitions } };
    const result = previewRedundantMissions(input);
    assert.equal(result.removable, 0); assert.deepEqual(result.value, input);
  }
});
