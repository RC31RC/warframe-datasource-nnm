import assert from "node:assert/strict";
import { test } from "node:test";
import { projectWeapons } from "../src/collectors/market.js";
import { projectRiven } from "../src/projections/riven.js";
import type { DatasetFileInput } from "../src/domain/contracts.js";

test("projects Market riven weapons with stable keys and required fields", () => {
  const records = projectWeapons({ data: [
    { slug: "latron", gameRef: "/Lotus/Weapons/Tenno/Rifle/Latron", group: "rifle", rivenType: "rifle", disposition: 1.2, i18n: { en: { name: "Latron" } } },
    { slug: "nikana", group: "melee", rivenType: "melee", disposition: 1.0, i18n: { en: { name: "Nikana" } } },
  ] });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.recordKey, "latron");
  assert.equal(records[0]?.name, "Latron");
  assert.equal(records[0]?.rivenType, "rifle");
  assert.throws(() => projectWeapons({ data: [{ slug: "latron" }, { slug: "latron" }] }), /Duplicate/u);
});

test("projects riven definitions and disposition from official exports", () => {
  const capturedAt = "2026-10-22T00:00:00.000Z";
  const upgrades = {
    ExportUpgrades: [
      { uniqueName: "/Lotus/Upgrades/Mods/PlainMod", name: "Plain" },
      {
        uniqueName: "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare",
        name: "Rifle Riven Mod",
        upgradeEntries: [{ tag: "WeaponDamageMod", prefixTag: "visi", suffixTag: "ata", upgradeValues: [{ value: 0.01, locTag: "|val|%" }] }],
        availableChallenges: [{ fullName: "/Lotus/Types/Challenges/RandomizedKill", description: "Kill |COUNT|", complications: [{ fullName: "/Lotus/Types/Challenges/Complications/ResetOnDamageTaken", description: "without damage" }] }],
      },
    ],
  };
  const weapons = {
    ExportWeapons: [
      { uniqueName: "/Lotus/Weapons/Tenno/Rifle/Latron", name: "Latron", omegaAttenuation: 1.2 },
      { uniqueName: "/Lotus/Weapons/Infested/Pistols/InfKitGun/Part", name: "Vermisplicer", omegaAttenuation: 1.15, primeOmegaAttenuation: 0.9 },
    ],
    ExportRailjackWeapons: [{ uniqueName: "/Lotus/Weapons/Railjack/Turret", name: "Turret", omegaAttenuation: 0.8 }],
  };
  const files: DatasetFileInput[] = [
    { stage: "raw", path: "public-export/en/ExportUpgrades_en.json", content: JSON.stringify(upgrades), source: source("ExportUpgrades/en", capturedAt) },
    { stage: "raw", path: "public-export/zh/ExportUpgrades_zh.json", content: JSON.stringify({
      ExportUpgrades: [{ uniqueName: "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare", name: "步枪紫卡" }],
    }), source: source("ExportUpgrades/zh", capturedAt) },
    { stage: "raw", path: "public-export/en/ExportWeapons_en.json", content: JSON.stringify(weapons), source: source("ExportWeapons/en", capturedAt) },
    { stage: "raw", path: "languages/en.json", content: JSON.stringify({
      "/Lotus/Language/Upgrades/WeaponDamage": "|val|%",
      "/Lotus/Language/Challenges/Challenge_RandomizedKill_Description": "Kill |COUNT|",
      "/Lotus/Language/Challenges/Complications/ResetOnDamageTaken": "without damage",
    }), source: source("languages/en", capturedAt) },
    { stage: "raw", path: "languages/zh.json", content: JSON.stringify({
      "/Lotus/Language/Upgrades/WeaponDamage": "|val|% 伤害",
      "/Lotus/Language/Challenges/Challenge_RandomizedKill_Description": "击杀 |COUNT| 名敌人",
      "/Lotus/Language/Challenges/Complications/ResetOnDamageTaken": "不受伤害",
    }), source: source("languages/zh", capturedAt) },
  ];
  const languagesFiles = files.filter((f) => f.path.startsWith("languages/"));
  const output = projectRiven(files, languagesFiles);

  const definitions = output.find((f) => f.path === "riven/definitions.json");
  assert.ok(definitions);
  const defRecords = JSON.parse(String(definitions.content)) as Array<Record<string, unknown>>;
  assert.equal(defRecords.length, 1);
  assert.equal(defRecords[0]?.recordKey, "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare");
  // 中文补全：Mod 名 + 词条 locTag + 挑战 description + complication
  assert.equal(defRecords[0]?.nameZh, "步枪紫卡");
  const entry = (defRecords[0]?.upgradeEntries as Array<Record<string, unknown>>)[0];
  const upgradeValue = (entry?.upgradeValues as Array<Record<string, unknown>>)[0];
  assert.equal(upgradeValue?.locTagZh, "|val|% 伤害");
  const challenge = (defRecords[0]?.availableChallenges as Array<Record<string, unknown>>)[0];
  assert.equal(challenge?.descriptionZh, "击杀 |COUNT| 名敌人");
  const complication = (challenge?.complications as Array<Record<string, unknown>>)[0];
  assert.equal(complication?.descriptionZh, "不受伤害");

  const disposition = output.find((f) => f.path === "riven/disposition.json");
  assert.ok(disposition);
  const dispRecords = JSON.parse(String(disposition.content)) as Array<Record<string, unknown>>;
  assert.equal(dispRecords.length, 3);
  const vermisplicer = dispRecords.find((r) => r.uniqueName === "/Lotus/Weapons/Infested/Pistols/InfKitGun/Part");
  assert.equal(vermisplicer?.disposition, 1.15);
  assert.equal(vermisplicer?.primeDisposition, 0.9);
  assert.deepEqual(disposition.source.derivedFrom, ["public-export/en/ExportWeapons_en.json"]);
});

function source(dataset: string, capturedAt: string) {
  return {
    project: "Digital Extremes Public Export",
    dataset,
    url: `https://content.warframe.com/PublicExport/Manifest/${dataset}.json!hash`,
    capturedAt,
    upstreamRevision: "hash",
  };
}
