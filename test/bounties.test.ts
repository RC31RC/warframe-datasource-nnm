import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetFileInput } from "../src/domain/contracts.js";
import { consolidateBounties } from "../src/projections/bounties.js";
import { supplementCreditBundles } from "../src/projections/credit-bundles.js";
import { enrichNameZh } from "../src/projections/enrich.js";
import { enrichPlusReferences } from "../src/projections/plus.js";
import { finishProducts } from "../src/projections/finish.js";
const file = (path: string, value: unknown): DatasetFileInput => ({ stage: "cleaned", path, content: JSON.stringify(value), source: { project: "test", dataset: path, url: "https://example.invalid", capturedAt: "2026-10-24T00:00:00Z" } });
const read = (value: DatasetFileInput) => JSON.parse(String(value.content));

test("bounties own all level pools and stages; generic drops keep remaining rewards with accurate counts", () => {
  const contexts = ["Hex Bounty Rewards", "Hex Bounty Rewards", "Missions"].map((category, index) => ({ category, source: { name: `Level ${index}` }, rewards: [], groups: [{ name: "Final stage", rewards: [{ probability: 0.25, item: { identityResolution: "unique", nameZh: "奖励" } }], groups: [] }] }));
  const files = [file("plus/bounties.json", { "/Lotus/Job": { nameEn: "Job" } }), file("drop/tables.json", { contexts, quality: { rewardCount: 3, reverseIndexReconciliation: {} } })];
  const before = JSON.stringify(files), output = consolidateBounties(files);
  assert.equal(JSON.stringify(files), before);
  const bounties = read(output[0]!); assert.equal(bounties.rewardPools["Hex Bounty Rewards"].length, 2);
  assert.equal(bounties.definitions["/Lotus/Job"].nameEn, "Job");
  assert.equal(bounties.rewardPools["Hex Bounty Rewards"][0].groups[0].rewards[0].probability, 0.25);
  const drops = read(output[1]!); assert.equal(drops.contexts.length, 1); assert.equal(drops.quality.rewardCount, 1);
  assert.equal(drops.quality.itemIdentity.unique, 1);
});

test("confirmed cash-cache localization survives projection without guessed amount or icon; extracted object wins", () => {
  const id = "/Lotus/Types/PickUps/Credits/50000Credits", key = "/Lotus/Language/Currency/50000Credits";
  const languages = [file("languages/en.json", { [key]: "50,000 Credits Cache" }), file("languages/zh.json", { [key]: "50,000 现金匣" })];
  const project = (value: unknown) => finishProducts(enrichPlusReferences(enrichNameZh(supplementCreditBundles([file("plus/creditbundles.json", value)], languages), languages), []), []);
  const partial = read(project({})[0]!)[id];
  assert.equal(partial.nameEn, "50,000 Credits Cache"); assert.equal(partial.nameZh, "50,000 现金匣");
  assert.equal(partial.credits, undefined); assert.equal(partial.iconUrl, undefined);
  assert.equal(partial.definitionStatus, "localized_definition_only");
  const complete = read(project({ [id]: { name: key, credits: 54321 } })[0]!)[id];
  assert.equal(complete.credits, 54321); assert.equal(complete.definitionStatus, "complete");
});

test("exact reward references expand all rotations without inventing an awarded item", () => {
  const pool = "/Lotus/Pool", item = "/Lotus/Item";
  const files = [file("plus/rewards.json", { [pool]: [[{ type: item, itemCount: 4, probability: 0.25 }], [{ type: item, itemCount: 2, probability: 1 }]] }), file("plus/test.json", { rewards: pool })];
  const output = enrichPlusReferences(files, [file("catalog/i18n/items.json", { [item]: { en: { name: "Item" }, zh: { name: "物品" } } })]);
  const row = read(output[1]!), ref = row.itemReferences[0];
  assert.equal(row.rewards, pool); assert.equal(ref.resolution, "exact_reward_pool");
  assert.equal(ref.rotations.length, 2); assert.equal(ref.rotations[0][0].item.nameZh, "物品");
  assert.equal(ref.rotations[0][0].probability, 0.25); assert.equal(ref.rotations[0][0].itemCount, 4);
});
