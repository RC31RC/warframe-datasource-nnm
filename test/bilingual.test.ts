import test from "node:test";
import assert from "node:assert/strict";
import { finalizeBilingualProducts, splitItemLocalizations } from "../src/projections/bilingual.js";
import { compactProducts } from "../src/projections/compact.js";
import { LOCALES } from "../src/collectors/public-export.js";
import type { DatasetFileInput } from "../src/domain/contracts.js";
const file = (path: string, value: unknown): DatasetFileInput => ({ path, stage: "cleaned", content: JSON.stringify(value),
  source: { project: "fixture", dataset: path, url: "https://example.test/data", capturedAt: "2026-10-25T00:00:00Z" } });
const values = (files: DatasetFileInput[]) => Object.fromEntries(files.map((row) => [row.path, JSON.parse(String(row.content))]));

test("only acquires en/zh and splits localization DTOs without losing identities or lines", () => {
  assert.deepEqual(LOCALES, ["en", "zh"]);
  const result = splitItemLocalizations({
    lex: { en: { name: "Lex Prime", description: "Pistol" }, zh: { name: "雷克斯 Prime", description: "手枪" }, de: { name: "ignored" } },
    missing: { zh: { name: "仅中文" } },
    mod: { en: { name: "Mod", description: ["one", "two"] }, zh: { name: "振幅晶体", description: ["一"] } },
    frame: { en: { name: "Frame", abilities: [{ abilityUniqueName: "/A", abilityName: "A" }, { abilityUniqueName: "/B", abilityName: "B" }] },
      zh: { name: "战甲", abilities: [{ abilityUniqueName: "/B", abilityName: "乙" }, { abilityUniqueName: "/A", abilityName: "甲" }, { abilityUniqueName: "/C", abilityName: "丙" }] } },
  });
  const items = result["reference/item-localizations.json"];
  assert.deepEqual(items.lex, { uniqueName: "lex", name: "Lex Prime", zhName: "雷克斯 Prime", iconUrl: null, description: "Pistol", zhDescription: "手枪" });
  assert.deepEqual(Object.keys(items.lex as object), Object.keys(items.missing as object));
  assert.deepEqual((result["reference/upgrade-localizations.json"].mod as Record<string, unknown>).descriptions,
    [{ lineIndex: 0, text: "one", zhText: "一" }, { lineIndex: 1, text: "two", zhText: null }]);
  const abilities = (result["reference/ability-owner-localizations.json"].frame as Record<string, unknown>).abilities as Record<string, unknown>[];
  assert.deepEqual(abilities.map((row) => [row.abilityUniqueName, row.zhAbilityName]), [["/A", "甲"], ["/B", "乙"], ["/C", "丙"]]);
  assert.equal(abilities[2]?.abilityName, null);
});

test("rejects localization fields, duplicate ability IDs and conflicting bilingual values", () => {
  assert.throws(() => splitItemLocalizations({ a: { en: { newField: "keep me" } } }), /unsupported localization field/);
  assert.throws(() => splitItemLocalizations({ a: { en: { abilities: [{ abilityUniqueName: "/A" }, { abilityUniqueName: "/A" }] } } }), /duplicate ability/);
  assert.throws(() => finalizeBilingualProducts([file("market/trade-items.json", [{ name: "A", i18n: { en: { name: "B" } } }])]), /conflicting localized field/);
});

test("removes missions only after complete enriched coverage and rejects missing fields", () => {
  const input = { A: { missions: { MT_A: { enemies: ["a", "b"] } }, missionDefinitions: [{ missionType: "MT_A", enemies: ["a", "b"], nameZh: "任务" }] } };
  const output = values(finalizeBilingualProducts([file("world/tilesets.json", input)]));
  assert.deepEqual(output["world/tilesets.json"], { A: { missionDefinitions: input.A.missionDefinitions } });
  assert.throws(() => finalizeBilingualProducts([file("world/tilesets.json", { A: { missions: { MT_A: { enemies: ["a"] } }, missionDefinitions: [] } })]), /retain every/);
});

test("inlines locale maps and pairs translated rank lines while preserving scalar descriptions", () => {
  const input = [file("world/star-chart.json", { systems: [{ name: "Earth", nameZh: "地球", translations: { en: { name: "Earth" }, zh: { name: "地球" }, fr: { name: "Terre" } } }] }),
    file("upgrades/mods.json", [{ description: ["one", "two"], descriptionZh: ["一"], ranks: [{ rank: 0, stats: { stats: ["+1"] }, statsZh: { stats: ["加一"] } }] },
      { description: "scalar", descriptionZh: "字符串" }])];
  const output = values(finalizeBilingualProducts(compactProducts(input)));
  assert.deepEqual(output["world/star-chart.json"], { systems: [{ name: "Earth", zhName: "地球" }] });
  assert.deepEqual(output["upgrades/mods.json"][0].ranks[0], { rank: 0, stats: [{ lineIndex: 0, text: "+1", zhText: "加一" }] });
  assert.equal(output["upgrades/mods.json"][0].description, null);
  assert.equal(output["upgrades/mods.json"][1].description, "scalar");
  assert.deepEqual(output["upgrades/mods.json"][1].descriptionLines, []);
});

test("normalizes enemy avatar variants without dropping their already enriched references", () => {
  const reference = { field: "STANDARD", uniqueName: "/Avatar", nameZh: "敌人" };
  const output = values(finalizeBilingualProducts([file("world/enemies.json", { agents: { agent: { avatarTypes: { STANDARD: "/Avatar", itemReferences: [reference] } } } })]));
  assert.deepEqual(output["world/enemies.json"].agents.agent.avatarTypes, [{ variant: "STANDARD", uniqueName: "/Avatar", reference__field: "STANDARD", reference__uniqueName: "/Avatar", reference__nameZh: "敌人" }]);
});

test("finalization is idempotent, preserves raw/language files, and detects conflicting split destinations", () => {
  const input = [{ ...file("catalog/i18n/items.json", { a: { en: { name: "A" } }, b: { en: { name: "B", abilities: [] } } }), recordCount: 2 }, file("languages/en.json", { i18n: "literal" })];
  const first = finalizeBilingualProducts(input), second = finalizeBilingualProducts(first);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.path, "catalog/i18n/items.json"); // Publisher retains the alias for derivedFrom rewriting.
  assert.equal(first[0]?.recordCount, 1);
  assert.equal(first[1]?.recordCount, 1);
  assert.equal(first.find((row) => row.path === "languages/en.json"), input[1]);
  assert.throws(() => finalizeBilingualProducts([...input, file("reference/ability-owner-localizations.json", {})]), /Conflicting localization destination/);
});

test("merges the two language dictionaries on exact keys, retaining one-sided and empty translations", () => {
  const output = finalizeBilingualProducts([file("languages/en.json", { a: "English", b: "", c: "Only EN" }), file("languages/zh.json", { a: "中文", b: "", d: "仅中文" })]);
  assert.deepEqual(values(output), { "reference/language-strings.json": {
    a: { key: "a", text: "English", zhText: "中文" }, b: { key: "b", text: "", zhText: "" },
    c: { key: "c", text: "Only EN", zhText: null }, d: { key: "d", text: null, zhText: "仅中文" },
  } });
  assert.deepEqual(output, finalizeBilingualProducts(output));
});

test("the final split keeps publisher provenance references resolvable through existing aliases", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatasetPublisher } = await import("../src/publish/dataset-publisher.js");
  const temporary = await mkdtemp(join(tmpdir(), "wf-bilingual-publish-"));
  try {
    const localized = file("catalog/i18n/items.json", { a: { en: { name: "A" } } });
    const market = file("market/items.json", [{ name: "A", i18n: { en: { name: "A" } } }]);
    market.source.derivedFrom = [localized.path];
    const publisher = new DatasetPublisher(join(temporary, "data"), join(temporary, "tmp"));
    const result = await publisher.publish(finalizeBilingualProducts([localized, market]));
    assert.ok(result.manifest.files.some((row) => row.path === "reference/item-localizations.json.gz"));
    assert.ok(result.manifest.files.some((row) => row.path === "market/trade-items.json.gz"));
    assert.equal((await publisher.verify()).verifiedFiles, 4);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
