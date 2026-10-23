import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDropTables } from "../src/collectors/droptables.js";
import { ordinaryCandidates } from "../src/projections/identity.js";
import { drawMechanism, percentProbability } from "../src/projections/probability.js";
import { consolidateRecipes } from "../src/projections/recipes.js";
import { enrichPlusReferences } from "../src/projections/plus.js";
import { enrichRivenAttributes } from "../src/projections/riven-attributes.js";
import { enrichNameZh } from "../src/projections/enrich.js";
import { finishProducts } from "../src/projections/finish.js";
import { canonicalProductPath } from "../src/publish/dataset-publisher.js";
import type { DatasetFileInput } from "../src/domain/contracts.js";

const source = { project: "test", dataset: "test", url: "https://example.invalid", capturedAt: "2026-10-23T00:00:00Z" };
const file = (path: string, value: unknown): DatasetFileInput => ({ stage: "cleaned", path, content: JSON.stringify(value), source });
const read = (value: DatasetFileInput) => JSON.parse(String(value.content));

test("preserves repeated source pool boundaries and review/unknown probabilities", () => {
  const rows = parseDropTables('<h3>Resource Drops by Source:</h3><table><tr><th>Enemy Resource Drop Chance: 400%</th></tr><tr><td>A</td><td>Beyond Legendary (Under Review) (0.00%)</td></tr><tr class="blank-row"></tr><tr><th>Enemy Resource Drop Chance: 400%</th></tr><tr><td>B</td><td>Under Review</td></tr></table>');
  assert.equal(rows[0]?.chance, 0);
  assert.match(rows[0]?.rarity ?? "", /Under Review/u);
  assert.equal(rows[1]?.chance, null);
  assert.equal(rows[1]?.sourceChanceText, "Under Review");
  assert.notEqual(rows[0]?.sourceTableIndex, rows[1]?.sourceTableIndex);
  assert.equal(rows[0]?.sourceDropChancePercent, 400);
});

test("keeps pool draws, activation, reward probability, and quantities distinct", () => {
  assert.deepEqual(drawMechanism(4), { drawCount: 4, activationProbability: 1, drawMode: "same_pool" });
  assert.equal(drawMechanism(0.15).activationProbability, 0.15);
  assert.equal(drawMechanism(1.5).mechanismResolution, "unresolved");
  assert.equal(percentProbability(25), 0.25);
  assert.equal(percentProbability(null), null);
  assert.throws(() => percentProbability(400), /outside/u);
  const [out] = enrichPlusReferences([file("plus/rewards.json", { chance: 4, items: [{ type: "/Lotus/A", probability: 0.25, itemCount: 20 }] })], []);
  const reward = read(out!);
  assert.equal(reward.chance, undefined);
  assert.equal(reward.drawCount, 4);
  assert.equal(reward.items[0].probability, 0.25);
  assert.equal(reward.items[0].itemCount, 20);
});

test("selects ordinary Mods and base resources while preserving genuine ambiguity", () => {
  const base = "/Lotus/Types/Items/MiscItems/PolymerBundle";
  assert.deepEqual(ordinaryCandidates([base, base + "240TutorialQuest", base + "RaidTutorial"], "Polymer Bundle"), [base]);
  const id = "/Lotus/Upgrades/Mods/Melee/WeaponMeleeDamageMod";
  assert.deepEqual(ordinaryCandidates([id, "/Lotus/Upgrades/Mods/Beginner/WeaponMeleeDamageMod"], "Pressure Point"), [id]);
  assert.equal(ordinaryCandidates(["/Lotus/A", "/Lotus/B"], "A").length, 2);
});

test("aliases only identical manufacturing behavior and retains every identity", () => {
  const recipe = { uniqueName: "/Lotus/A", recordKey: "/Lotus/A", resultType: "/Lotus/Result", num: 1, buildTime: 60, ingredients: [{ ItemType: "/Lotus/Material", ItemCount: 2 }] };
  const recipes = consolidateRecipes({ "/Lotus/A": recipe, "/Lotus/B": { ...recipe, uniqueName: "/Lotus/B", recordKey: "/Lotus/B" }, "/Lotus/C": { ...recipe, resultType: "/Lotus/Other" }, "/Lotus/D": { ...recipe, buildTime: 120 } });
  assert.equal(Object.keys(recipes).length, 3);
  assert.deepEqual(recipes["/Lotus/A"]?.identityAliases, ["/Lotus/B"]);
  assert.ok(recipes["/Lotus/C"]);
  assert.ok(recipes["/Lotus/D"]);
});

test("riven attributes use exact game tags and retain signed class parameters without placeholder images", () => {
  const definitions = [file("riven/definitions.json", [{ uniqueName: "/Lotus/Riven", name: "Rifle Riven", nameZh: "步枪裂罅", upgradeEntries: [{ tag: "Damage", upgradeValues: [{ value: -0.25, locTagZh: "|val|%伤害" }] }] }])];
  const [out] = enrichRivenAttributes([file("market/riven-attributes.json", [{ gameRef: "Damage", slug: "damage", i18n: { en: { name: "Damage", icon: "https://example.invalid/unknown.png" } } }])], definitions);
  const attribute = read(out!)[0];
  assert.equal(attribute.nameZh, "伤害");
  assert.equal(attribute.officialEntries[0].upgradeValues[0].value, -0.25);
  assert.equal(attribute.definitionResolution, "exact_game_tag");
  assert.equal(attribute.i18n.en.icon, undefined);
  assert.equal(attribute.iconStatus, "missing");
});

test("publishes exact official asset hashes and truthful missing-icon status", () => {
  const [out] = finishProducts([file("plus/animals.json", [{ uniqueName: "/Lotus/Animal", name: "Animal", nameZh: "动物", icon: "/Lotus/Animal.png" }, { uniqueName: "/Lotus/Missing", iconUrl: "https://example.invalid/unknown.png" }])], [file("public-export/shared/ExportManifest.json", { Manifest: [{ uniqueName: "/Lotus/Animal", textureLocation: "Lotus/Animal.png!hash" }] })]);
  const [animal, missing] = read(out!);
  assert.equal(animal.iconUrl, "https://content.warframe.com/PublicExport/Lotus/Animal.png!hash");
  assert.equal(animal.nameEn, "Animal");
  assert.equal(missing.iconStatus, "missing");
  assert.equal(missing.iconUrl, undefined);
});



test("business product paths no longer expose deep collector structure", () => {
  assert.equal(canonicalProductPath("catalog/equipment/warframes.json"), "equipment/warframes.json");
  assert.equal(canonicalProductPath("catalog/loot/relics.json"), "rewards/relics.json");
  assert.equal(canonicalProductPath("market/riven-attributes.json"), "upgrades/riven-attributes.json");
  assert.equal(canonicalProductPath("plus/bounties.json"), "rewards/bounties.json");
});

test("complementary official catalogs union identities and retain localizations and extra gameplay fields", async () => {
  const { supplementCatalogs } = await import("../src/projections/supplements.js");
  const raw = (path: string, value: unknown) => ({ ...file(path, value), stage: "raw" as const });
  const id = "/Lotus/GearA", extra = "/Lotus/GearB";
  const output = supplementCatalogs([file("catalog/i18n/items.json", {})], [
    raw("public-export/en/ExportGear_en.json", { ExportGear: [{ uniqueName: id, name: "Official A", description: "Description" }] }),
    raw("public-export/zh/ExportGear_zh.json", { ExportGear: [{ uniqueName: id, name: "官方甲", description: "描述" }] }),
  ], [raw("plus/ExportGear.json", { [id]: { name: "/Lotus/Language/A", maxCount: 5 }, [extra]: { name: "/Lotus/Language/B", maxCount: 10 } })], [file("languages/en.json", { "/Lotus/Language/A": "A", "/Lotus/Language/B": "B" }), file("languages/zh.json", { "/Lotus/Language/A": "甲", "/Lotus/Language/B": "乙" })]);
  const gear = read(output.find((entry) => entry.path === "equipment/gear.json")!);
  assert.equal(Object.keys(gear).length, 2);
  assert.equal(gear[id].name, "Official A");
  assert.equal(gear[id].nameZh, "官方甲");
  assert.equal(gear[id].maxCount, 5);
  assert.equal(gear[extra].nameEn, "B");
  const translations = read(output.find((entry) => entry.path === "catalog/i18n/items.json")!);
  assert.equal(translations[id].en.name, "Official A");
  assert.equal(translations[extra].zh.name, "乙");
});

test("catalog union deduplicates identical identities and rejects conflicting records before publishing", async () => {
  const { supplementCatalogs } = await import("../src/projections/supplements.js");
  const id = "/Lotus/Weapon", weapon = { uniqueName: id, name: "Weapon", damage: 10 };
  const input = (rows: unknown[]) => [file("catalog/i18n/items.json", {}), file("catalog/equipment/weapons.json", rows)];
  const plus = [{ ...file("plus/ExportWeapons.json", { [id]: { name: "Weapon", introducedAt: "2026" } }), stage: "raw" as const }];
  const output = supplementCatalogs(input([weapon, { ...weapon }]), [], plus, []);
  const weapons = read(output.find((entry) => entry.path === "catalog/equipment/weapons.json")!);
  assert.equal(weapons.length, 1);
  assert.equal(weapons[0].introducedAt, "2026");
  assert.throws(() => supplementCatalogs(input([weapon, { ...weapon, damage: 20 }]), [], plus, []), /Conflicting duplicate identity/u);
});

test("official localized export duplicates are only collapsed when records are identical", async () => {
  const { supplementCatalogs } = await import("../src/projections/supplements.js");
  const id = "/Lotus/Resource", record = { uniqueName: id, name: "Resource" };
  const catalog = [file("catalog/i18n/items.json", {})];
  const english = [{ ...file("public-export/en/ExportResources_en.json", { ExportResources: [record, { ...record }] }), stage: "raw" as const }];
  const output = supplementCatalogs(catalog, english, [], []);
  assert.equal(Object.keys(read(output.find((entry) => entry.path === "resources/items.json")!)).length, 1);
  const conflicting = [{ ...file("public-export/en/ExportResources_en.json", { ExportResources: [record, { ...record, name: "Other" }] }), stage: "raw" as const }];
  assert.throws(() => supplementCatalogs(catalog, conflicting, [], []), /Conflicting duplicate identity/u);
});

test("complementary upgrade ranks and new recipe ingredients follow the same nested contract", async () => {
  const { supplementCatalogs } = await import("../src/projections/supplements.js");
  const raw = (path: string, value: unknown) => ({ ...file(path, value), stage: "raw" as const });
  const output = supplementCatalogs([
    file("catalog/i18n/items.json", { "/Lotus/Material": { en: { name: "Material" }, zh: { name: "材料" } } }),
    file("catalog/upgrades/arcanes.json", []), file("catalog/craft/recipes.json", {}),
  ], [], [
    raw("plus/ExportArcanes.json", { "/Lotus/Arcane": { name: "Arcane", levelStats: [{ stats: ["Effect"] }] } }),
    raw("plus/ExportRecipes.json", { "/Lotus/Recipe": { resultType: "/Lotus/Result", ingredients: [{ ItemType: "/Lotus/Material", ItemCount: 3 }] } }),
  ], []);
  const arcane = read(output.find((entry) => entry.path === "catalog/upgrades/arcanes.json")!)[0];
  assert.equal(arcane.levelStats, undefined);
  assert.equal(arcane.ranks[0].rank, 0);
  const recipe = read(output.find((entry) => entry.path === "catalog/craft/recipes.json")!)["/Lotus/Recipe"];
  assert.equal(recipe.recipeKind, "ordinary");
  assert.equal(recipe.ingredients[0].item.nameZh, "材料");
  assert.equal(recipe.ingredients[0].ItemCount, 3);
});

test("recipe aliases survive repeated normalization and resolve to the canonical identity", async () => {
  const { identityDetails } = await import("../src/projections/identity.js");
  const input = { "/Lotus/A": { uniqueName: "/Lotus/A", name: "Blueprint", resultType: "/Lotus/Result", identityAliases: ["/Lotus/Old"] }, "/Lotus/B": { uniqueName: "/Lotus/B", name: "Blueprint", resultType: "/Lotus/Result" } };
  const result = consolidateRecipes(input);
  assert.deepEqual(result["/Lotus/A"]?.identityAliases, ["/Lotus/B", "/Lotus/Old"]);
  assert.deepEqual(consolidateRecipes(result), result);
  assert.equal(identityDetails([file("crafting/recipes.json", result)]).get("/Lotus/Old")?.uniqueName, "/Lotus/A");
});




test("bilingual display enrichment preserves locale dictionaries without mislabelling localized names as English", () => {
  const localized = { en: { name: "Item" }, zh: { name: "物品" }, ja: { name: "アイテム" } };
  const inputs = [file("market/items.json", [{ name: "Item", i18n: localized, translations: localized }]), file("catalog/i18n/items.json", { "/Lotus/Item": localized })];
  const languages = [file("languages/en.json", { "/Lotus/Language/Item": "Item" }), file("languages/zh.json", { "/Lotus/Language/Item": "物品" })];
  const output = finishProducts(enrichNameZh(inputs, languages), []);
  const item = read(output[0]!)[0];
  assert.equal(item.nameEn, "Item");
  assert.equal(item.nameZh, "物品");
  assert.deepEqual(item.i18n, localized);
  assert.deepEqual(item.translations, localized);
  assert.deepEqual(read(output[1]!), { "/Lotus/Item": localized });
});


test("special-action Blueprint identities still get product-based bilingual names without losing their action", async () => {
  const { supplementCatalogs } = await import("../src/projections/supplements.js");
  const output = supplementCatalogs([
    file("catalog/i18n/items.json", { "/Lotus/Specter": { en: { name: "Phase Specter" }, zh: { name: "相位魅影" } } }),
    file("catalog/craft/recipes.json", {}),
  ], [], [{ ...file("plus/ExportRecipes.json", { "/Lotus/SpecterBlueprint": { resultType: "/Lotus/Specter", secretIngredientAction: "SIA_SPECTRE_LOADOUT_COPY" } }), stage: "raw" as const }], []);
  const names = read(output.find((entry) => entry.path === "catalog/i18n/items.json")!)["/Lotus/SpecterBlueprint"];
  assert.equal(names.en.name, "Phase Specter Blueprint");
  assert.equal(names.zh.name, "相位魅影蓝图");
  const recipe = read(output.find((entry) => entry.path === "catalog/craft/recipes.json")!)["/Lotus/SpecterBlueprint"];
  assert.equal(recipe.recipeKind, "special_action");
  assert.equal(recipe.actionKey, "SIA_SPECTRE_LOADOUT_COPY");
});
