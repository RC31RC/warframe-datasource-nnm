import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetFileInput } from "../src/domain/contracts.js";
import { warframePages, pageMedia } from "../src/collectors/official-media.js";
import { enrichOfficialMedia } from "../src/projections/media.js";
import { projectDropTables } from "../src/projections/drops.js";
import { projectActivityDefinitions } from "../src/projections/activities.js";
import { enrichBusinessDepth } from "../src/projections/business-depth.js";

const source = { project: "test", dataset: "test", url: "https://example.invalid", capturedAt: "2026-10-23T00:00:00Z" };
const file = (path: string, value: unknown, stage: "raw" | "cleaned" = "cleaned"): DatasetFileInput => ({ path, stage, source, content: JSON.stringify(value) });
const html = (path: string, content: string): DatasetFileInput => ({ path, content, stage: "raw", source });

test("official media uses exact game assets and active Prime media, without applying generic site images or prototype cards", () => {
  const icon = "/Lotus/Interface/Icons/StoreIcons/Primes/TestPrime.png";
  const index = `<a class="WarframeListTile is-unlined" data-type="prime" data-id="Test Prime" href="https://www.warframe.com/en/game/warframes/test-prime"><img src="https://content.warframe.com/PublicExport${icon}!hash"></a><a class="WarframeListTile" data-type="proto" href="https://www.warframe.com/en/game/warframes/test"><img src="https://www-static.warframe.com/proto.png"></a>`;
  const detail = '<meta property="og:image" content="https://www-static.warframe.com/generic.png"><video class="MastheadBackgroundVideo" poster="https://www-static.warframe.com/normal.jpg"></video><video class="MastheadBackgroundVideo is-active" poster="https://www-static.warframe.com/prime.jpg"><source src="https://www-static.warframe.com/prime.webm"></video>';
  assert.equal(warframePages(index).length, 1);
  assert.equal(pageMedia(detail).splashImageUrl, "https://www-static.warframe.com/prime.jpg");
  assert.equal(pageMedia('<meta property="og:image" content="https://www-static.warframe.com/generic.png">').splashImageUrl, undefined);
  const [result] = enrichOfficialMedia([file("catalog/equipment/warframes.json", { Prime: { icon }, Other: { icon: "/Lotus/Unrelated.png" } })], [html("official-site/warframes.html", index), html("official-site/warframes/test-prime.html", detail)]);
  const frames = JSON.parse(String(result!.content));
  assert.equal(frames.Prime.media.splashImageUrl, "https://www-static.warframe.com/prime.jpg");
  assert.equal(frames.Other.media, undefined);
  const [arrayResult] = enrichOfficialMedia([file("catalog/equipment/warframes.json", [{ uniqueName: "Prime", icon }, { uniqueName: "Other", icon: "/Lotus/Unrelated.png" }])], [html("official-site/warframes.html", index), html("official-site/warframes/test-prime.html", detail)]);
  const arrayFrames = JSON.parse(String(arrayResult!.content));
  assert.equal(arrayFrames.length, 2);
  assert.equal(arrayFrames[0].media.splashImageUrl, "https://www-static.warframe.com/prime.jpg");
  const abilityIcon = "/Lotus/Interface/Icons/Abilities/Test.png";
  const detailWithAbility = detail + `<img class="WarframeAbilityCard-image" src="https://www-static.warframe.com/ability.jpg"><img class="WarframeAbilityCard-icon" src="https://content.warframe.com/PublicExport${abilityIcon}!hash">`;
  const [urlResult] = enrichOfficialMedia([file("catalog/equipment/warframes.json", [{ iconUrl: `https://content.warframe.com/PublicExport${icon}!hash`, abilities: [{ abilityIconUrl: `https://content.warframe.com/PublicExport${abilityIcon}!hash` }] }])], [html("official-site/warframes.html", index), html("official-site/warframes/test-prime.html", detailWithAbility)]);
  const urlFrame = JSON.parse(String(urlResult!.content))[0];
  assert.equal(urlFrame.media.splashImageUrl, "https://www-static.warframe.com/prime.jpg");
  assert.equal(urlFrame.abilities[0].media.showcaseImageUrl, "https://www-static.warframe.com/ability.jpg");
});

test("linked official pools disambiguate rewards and unidentified pickups; categories never assign probability to candidates", () => {
  const bpA = "/Lotus/Types/Recipes/A", bpB = "/Lotus/Types/Recipes/B", fishA = "/Lotus/Types/Items/Fish/FishSmall", fishB = "/Lotus/Types/Items/Fish/FishLarge";
  const sourceId = "/Lotus/Types/Enemies/Test", dt = "/Lotus/Types/DropTables/Test", cell = "/Lotus/Types/PickUps/Cell";
  const names = { [bpA]: { en: { name: "Blueprint" }, zh: { name: "蓝图" } }, [bpB]: { en: { name: "Blueprint" }, zh: { name: "蓝图" } }, [fishA]: { en: { name: "Fish" }, zh: { name: "鱼" } }, [fishB]: { en: { name: "Fish" }, zh: { name: "鱼" } } };
  const catalog = [file("catalog/i18n/items.json", names), file("plus/enemies.json", { avatars: { [sourceId]: { name: "Enemy", droptable: dt } }, droptables: { [dt]: [{ type: "blueprint", items: [{ type: bpB, probability: 1 }] }, { type: "additionalItem", items: [{ type: cell, probability: 1 }] }] } })];
  const row = (category: string, item: string, source = "Enemy") => ({ category, item, source, groups: [], rarity: "Common", chance: 100 });
  const [output] = projectDropTables([html("droptables/droptables.html", ""), file("drop/test.json", [row("Blueprint/Item Drops by Source", "Blueprint"), row("Additional Item Drops by Source", "Powercell"), row("Additional Item Drops by Source", "Powercell", "Unexported Enemy"), row("Missions", "Fish")])], catalog, []);
  const data = JSON.parse(String(output!.content)), contexts = data.contexts;
  assert.equal(contexts.find((x: any) => x.category === "Blueprint/Item Drops by Source").rewards[0].item.uniqueName, bpB);
  const pickups = contexts.filter((x: any) => x.category === "Additional Item Drops by Source");
  assert.ok(pickups.every((x: any) => x.rewards[0].item.uniqueName === cell));
  const reward = contexts.find((x: any) => x.category === "Missions").rewards[0];
  assert.equal(reward.probability, 1);
  assert.equal(reward.item.identityResolution, "category");
  assert.equal(reward.item.candidates.length, 2);
  assert.ok(reward.item.candidates.every((x: any) => x.probability === undefined));
});

test("activity definitions retain exact keys and separate conflicting activity namespaces", () => {
  const prefix = "/Lotus/Language/Conquest/";
  const [result] = projectActivityDefinitions([file("languages/en.json", { [prefix + "SolarMapLabConquestNode"]: "Deep Archimedea", [prefix + "PersonalMod_NoPets"]: "No Pets Allowed", [prefix + "PersonalMod_NoPets_Desc"]: "Companions are disabled", [prefix + "Condition_Test"]: "Risk", [prefix + "Condition_Test_Desc"]: "Risk description", [prefix + "MissionVariant_LabConquest_Test"]: "Lab variant", [prefix + "MissionVariant_HexConquest_Test"]: "Hex variant" }), file("languages/zh.json", { [prefix + "Condition_Test"]: "风险", [prefix + "Condition_ChineseOnly"]: "中文独有" })]);
  const data = JSON.parse(String(result!.content));
  assert.equal(data.conquests.conditions.Test.nameZh, "风险");
  assert.equal(data.conquests.conditions.ChineseOnly.nameZh, "中文独有");
  assert.equal(data.conquests.conditions.ChineseOnly.nameEn, "");
  assert.equal(data.conquests.conditions.Test.descriptionEn, "Risk description");
  assert.equal(data.conquests.missionVariants.LabConquest.Test.nameEn, "Lab variant");
  assert.equal(data.conquests.missionVariants.HexConquest.Test.nameEn, "Hex variant");
  assert.equal(data.conquests.conditions.Test_Desc, undefined);
  assert.equal(data.conquests.types.CT_LAB.nameEn, "Deep Archimedea");
  assert.equal(data.conquests.personalModifiers.NoPets.descriptionEn, "Companions are disabled");
});

test("set membership, fusion quantities and mail subjects provide business displays without inventing original item names", () => {
  const output = enrichBusinessDepth([file("catalog/upgrades/mods.json", [{ uniqueName: "/Lotus/Mod", modSet: "/Lotus/Set", nameEn: "Member", nameZh: "成员" }]), file("catalog/upgrades/mod-sets.json", [{ uniqueName: "/Lotus/Set", description: "Set effect" }]), file("commerce/fusion-bundles.json", { "/Lotus/Endo": { name: "/Lotus/Language/Missing", fusionPoints: 150 } }), file("plus/emailitems.json", { "/Lotus/Mail": { message: { titleEn: "Subject", titleZh: "标题" } } })]);
  const set = JSON.parse(String(output[1]!.content))[0], bundle = JSON.parse(String(output[2]!.content))["/Lotus/Endo"], mail = JSON.parse(String(output[3]!.content))["/Lotus/Mail"];
  assert.equal(set.members[0].nameZh, "成员");
  assert.equal(set.name, undefined);
  assert.equal(bundle.displayNameEn, "150 Endo");
  assert.equal(bundle.name, "/Lotus/Language/Missing");
  assert.equal(mail.displayNameZh, "标题");
});

test("an otherwise unnamed selector is linked only by a complete official pool with multiple known identities", () => {
  const a = "/Lotus/Types/Items/A", b = "/Lotus/Types/Items/B", c = "/Lotus/Types/Items/C", selector = "/Lotus/Types/Lore/Fragments/TestRewards";
  const catalog = [file("catalog/i18n/items.json", Object.fromEntries([a, b, c].map((id) => [id, { en: { name: id.slice(-1) }, zh: { name: "物品" } }]))), file("plus/rewards.json", { "/Lotus/Types/Game/MissionDecks/TestRewards": [[{ type: a, itemCount: 1, probability: 0.1 }, { type: b, itemCount: 5, probability: 0.2 }, { type: c, itemCount: 1, probability: 0.3 }, { type: selector, itemCount: 1, probability: 0.4 }]] })];
  const rows = ["A", "B", "C", "Unknown fragments"].map((item, index) => ({ category: "Missions", source: "Bounty", item, groups: ["Stage"], rarity: "Common", chance: (index + 1) * 10 }));
  const [output] = projectDropTables([html("droptables/droptables.html", ""), file("drop/test.json", rows)], catalog, []);
  const reward = JSON.parse(String(output!.content)).contexts[0].groups[0].rewards[3].item;
  assert.equal(reward.uniqueName, selector);
  assert.equal(reward.kind, "reward_selector");
  const [unmatched] = projectDropTables([html("droptables/droptables.html", ""), file("drop/test.json", rows.slice(3))], catalog, []);
  assert.equal(JSON.parse(String(unmatched!.content)).contexts[0].groups[0].rewards[0].item.identityResolution, "unresolved");
});


test("new website ability tabs map exactly to corresponding video panels and reject mismatched panel counts", () => {
  const icons = '<div class="WarframeAbilityGrid-icons"><img class="WarframeAbilityIcon is-active" src="https://content.warframe.com/PublicExport/Lotus/AbilityA.png!hash"><img class="WarframeAbilityIcon" src="https://content.warframe.com/PublicExport/Lotus/AbilityB.png!hash"></div>';
  const panel = (name: string) => `<video class="WarframeAbilityVideo" poster="https://www-static.warframe.com/${name}.jpg"><source src="https://www-static.warframe.com/${name}.webm" type="video/webm"></video>`;
  const result = pageMedia(icons + '<div class="WarframeAbilityGrid-videos">' + panel("a") + panel("b") + '</div>');
  assert.deepEqual(result.abilities, [{ iconAsset: "/Lotus/AbilityA.png", imageUrl: "https://www-static.warframe.com/a.jpg", videoUrl: "https://www-static.warframe.com/a.webm" }, { iconAsset: "/Lotus/AbilityB.png", imageUrl: "https://www-static.warframe.com/b.jpg", videoUrl: "https://www-static.warframe.com/b.webm" }]);
  assert.equal(pageMedia(icons + '<div class="WarframeAbilityGrid-videos">' + panel("a") + '</div>').abilities.length, 0);
});
