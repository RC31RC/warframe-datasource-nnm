import test from "node:test";
import assert from "node:assert/strict";
import { compactProductValue, compactRecord, compactProducts } from "../src/projections/compact.js";

test("recursively merges singular records and promotes their independent arrays", () => {
  const result = compactRecord({ id: "a", b: [{ id: "b1" }, { id: "b2" }],
    media: { title: "c", item: { name: "d" }, images: [{ item: { name: "e1" } }, { item: { name: "e2" } }] } });
  assert.deepEqual(result, { id: "a", b: [{ id: "b1" }, { id: "b2" }],
    media__title: "c", media__item__name: "d", media__images: [{ item__name: "e1" }, { item__name: "e2" }] });
});
test("never merges arrays based on their current length or a singular-sounding field name", () => {
  assert.deepEqual(compactRecord({ item: [{ name: "one" }], dropTableEntries: [{ item: { name: "x" } }] }),
    { item: [{ name: "one" }], dropTableEntries: [{ item__name: "x" }] });
});
test("preserves keyed multi-record maps, including one-member maps and locales", () => {
  const input = { states: { Intact: { rewards: [{ item: { name: "x" } }] } }, i18n: { en: { name: "x" } } };
  assert.deepEqual(compactRecord(input), { states: { Intact: { rewards: [{ item__name: "x" }] } }, i18n: { en: { name: "x" } } });
});
test("does not flatten unknown upstream objects, absent values, nulls, empty objects or arrays", () => {
  const input = { unknown: { nested: { a: 1 } }, item: null, media: {}, rows: [], count: 0, enabled: false };
  assert.deepEqual(compactRecord(input), input);
});
test("fails on field collisions instead of overwriting existing fields", () => {
  assert.throws(() => compactRecord({ item: { name: "x" }, item__name: "y" }), /collision/);
  assert.throws(() => compactRecord({ item__name: "y", item: { name: "x" } }), /collision/);
});
test("respects root entity/section/localization dictionaries and stable IDs", () => {
  assert.deepEqual(compactProductValue({ item: { media: { url: "x" } } }, "equipment/gear.json"),
    { item: { media__url: "x" } });
  assert.deepEqual(compactProductValue({ agents: { item: { projectile: { attack: { damage: 3 } } } } }, "world/enemies.json"),
    { agents: { item: { projectile__attack__damage: 3 } } });
  assert.deepEqual(compactProductValue({ item: { en: { name: "x" }, zh: { name: "中" } } }, "reference/item-localizations.json"),
    { item: { en: { name: "x" }, zh: { name: "中" } } });
});
test("promotes activity dictionaries and flattens quality counters without merging collections", () => {
  assert.deepEqual(compactProductValue({ conquests: { types: { CT_LAB: { name: "Lab" } } } }, "worldstate/activities.json"),
    { conquests__types: { CT_LAB: { name: "Lab" } } });
  assert.deepEqual(compactRecord({ quality: { reverseIndexReconciliation: { mods: { matchedRows: 2 } } } }),
    { quality__reverseIndexReconciliation__mods__matchedRows: 2 });
});
test("is deterministic and idempotent; leaves raw inputs untouched", () => {
  const input = { item: { name: "x", candidateUniqueNames: ["a", "b"] } };
  const compact = compactRecord(input);
  assert.deepEqual(compactRecord(compact), compact);
  const raw = { stage: "raw" as const, path: "x.json", content: JSON.stringify(input),
    source: { project: "test", dataset: "test", url: "test", capturedAt: "2026-10-25T00:00:00Z" } };
  assert.equal(compactProducts([raw])[0], raw);
});

test("promoted keyed collections stay idempotent even when their IDs look like singular field names", () => {
  const input = { media: { states: { item: { name: "state A" }, source: { name: "state B" } } } };
  const result = compactRecord(input);
  assert.deepEqual(result, { media__states: { item: { name: "state A" }, source: { name: "state B" } } });
  assert.deepEqual(compactRecord(result), result);
});
