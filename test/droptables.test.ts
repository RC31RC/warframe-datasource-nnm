import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDropTables } from "../src/collectors/droptables.js";

test("parses Relics drops with rarity and chance", () => {
  const html = [
    "<h3>Relics:</h3><table>",
    "<tr><th colspan=\"2\">Axi A1 Relic (Intact)</th></tr>",
    "<tr><td>Akstiletto Prime Barrel</td><td>Uncommon (11.00%)</td></tr>",
    "<tr><td>Nikana Prime Blueprint</td><td>Rare (2.00%)</td></tr>",
    "<tr class=\"blank-row\"><td colspan=\"2\"></td></tr>",
    "<tr><th colspan=\"2\">Axi A1 Relic (Radiant)</th></tr>",
    "<tr><td>Akstiletto Prime Barrel</td><td>Common (50.00%)</td></tr>",
    "</table>",
  ].join("");
  const entries = parseDropTables(html);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    category: "Relics",
    source: "Axi A1 Relic (Intact)",
    groups: [],
    item: "Akstiletto Prime Barrel",
    rarity: "Uncommon",
    chance: 11,
  });
  assert.equal(entries[1]?.rarity, "Rare");
  assert.equal(entries[2]?.source, "Axi A1 Relic (Radiant)");
  assert.equal(entries[2]?.chance, 50);
});

test("parses Missions with Rotation subgroups", () => {
  const html = [
    "<h3>Missions:</h3><table>",
    "<tr><th colspan=\"2\">Void/Mithra (Interception)</th></tr>",
    "<tr><th colspan=\"2\">Rotation A</th></tr>",
    "<tr><td>Neo C7 Relic</td><td>Rare (9.09%)</td></tr>",
    "<tr><th colspan=\"2\">Rotation C</th></tr>",
    "<tr><td>Lith L8 Relic</td><td>Uncommon (11.06%)</td></tr>",
    "</table>",
  ].join("");
  const entries = parseDropTables(html);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.source, "Void/Mithra (Interception)");
  assert.deepEqual(entries[0]?.groups, ["Rotation A"]);
  assert.equal(entries[0]?.item, "Neo C7 Relic");
  assert.deepEqual(entries[1]?.groups, ["Rotation C"]);
  assert.equal(entries[1]?.item, "Lith L8 Relic");
});

test("parses Bounty three-column rows with empty first cell", () => {
  const html = [
    "<h3>Cetus Bounty Rewards:</h3><table>",
    "<tr><th colspan=\"3\">Level 5 - 15 Cetus Bounty</th></tr>",
    "<tr><th colspan=\"3\">Rotation A</th></tr>",
    "<tr><td class=\"pad-cell\"></td><th colspan=\"2\">Stage 1</th></tr>",
    "<tr><td></td><td>Redirection</td><td>Uncommon (20.00%)</td></tr>",
    "</table>",
  ].join("");
  const entries = parseDropTables(html);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.source, "Level 5 - 15 Cetus Bounty");
  assert.deepEqual(entries[0]?.groups, ["Rotation A", "Stage 1"]);
  assert.equal(entries[0]?.item, "Redirection");
  assert.equal(entries[0]?.chance, 20);
});

test("parses reverse-index drops with column header skipped", () => {
  const html = [
    "<h3>Mod Drops by Mod:</h3><table>",
    "<tr><th colspan=\"3\">Target Acquired</th></tr>",
    "<tr><th>Source</th><th>Mod Drop Chance</th><th>Chance</th></tr>",
    "<tr><td>Tusk Thumper Bull</td><td>15.00%</td><td>Uncommon (12.50%)</td></tr>",
    "</table>",
  ].join("");
  const entries = parseDropTables(html);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.source, "Target Acquired");
  assert.equal(entries[0]?.item, "Tusk Thumper Bull");
  assert.equal(entries[0]?.rarity, "Uncommon");
  assert.equal(entries[0]?.chance, 12.5);
});
