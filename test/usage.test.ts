import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsageData } from "../src/collectors/usage.js";

test("flattens nested Warframe usage data into records", () => {
  const payload = {
    ALL: {
      Warframe: {
        Ash: { ALL: 0.0011, "0": 0.0002, "1": 0.0005 },
        Excalibur: { ALL: 0.02 },
      },
      Primary: {
        "AX-52": { ALL: 0.0083, "5": 0.009 },
      },
    },
    PC: {
      Warframe: {
        Ash: { ALL: 0.001 },
      },
    },
  };
  const records = parseUsageData(Buffer.from(JSON.stringify(payload)), "2024");
  assert.equal(records.length, 7);
  const ashAll = records.find((r) => r.item === "Ash" && r.platform === "ALL" && r.rank === "ALL");
  assert.ok(ashAll);
  assert.equal(ashAll?.year, "2024");
  assert.equal(ashAll?.category, "Warframe");
  assert.equal(ashAll?.usage, 0.0011);
  const ax = records.find((r) => r.item === "AX-52");
  assert.equal(ax?.category, "Primary");
  assert.equal(ax?.rank, "5");
});

test("rejects malformed and empty Warframe usage payloads", () => {
  assert.throws(() => parseUsageData(Buffer.from("not json"), "2024"), /Invalid Warframe usage data/u);
  assert.throws(() => parseUsageData(Buffer.from("[]"), "2024"), /must be a JSON object/u);
  assert.throws(() => parseUsageData(Buffer.from("{}"), "2024"), /contains no records/u);
  assert.throws(() => parseUsageData(Buffer.from('{ "ALL": { "Warframe": { "Ash": { "ALL": "x" } } } }'), "2024"), /contains no records/u);
});
