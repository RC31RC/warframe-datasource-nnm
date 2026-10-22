import assert from "node:assert/strict";
import { test } from "node:test";
import { projectArbitrationSchedule } from "../src/projections/arbitration.js";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";

const capturedAt = "2026-10-21T00:00:00.000Z";
const source = (project: string, dataset: string, url = "https://example.invalid"): SourceMetadata => ({
  project, dataset, url, capturedAt,
});

function raw(path: string, content: string, src: SourceMetadata): DatasetFileInput {
  return { stage: "raw", path, content, source: src };
}

function cleaned(path: string, content: unknown): DatasetFileInput {
  return { stage: "cleaned", path, content: JSON.stringify(content), source: source("warframe-datasource-nnm", path) };
}

test("resolves arbys.txt rows via worldstate codebook", () => {
  const rawFile = raw(
    "arbitration/arbys.txt",
    "# comment\n1727884800,SolNode94\n1727888400,ClanNode10\n1727892000,UnknownNode999\n",
    source("browse.wf", "arbitration-schedule", "https://browse.wf/arbys.txt"),
  );
  const worldstateFiles = [
    cleaned("worldstate/nodes.json", {
      SolNode94: {
        name: "Apollodorus", nameZh: "阿波罗多罗斯", systemName: "Mercury", systemNameZh: "水星",
        missionType: "MT_SURVIVAL", missionTypeName: "SURVIVAL", missionTypeNameZh: "生存",
        faction: "FC_INFESTATION", factionName: "Infestation",
      },
      ClanNode10: {
        name: "Clan Hall", nameZh: "氏族大厅", systemName: "Dojo", systemNameZh: "道场",
        missionType: "MT_PVP", missionTypeName: "CONCLAVE", missionTypeNameZh: "武形秘仪",
        faction: "FC_TENNO", factionName: "Tenno",
      },
    }),
  ];

  const output = projectArbitrationSchedule(rawFile, worldstateFiles);
  assert.equal(output.length, 1);
  const result = JSON.parse(String(output[0]?.content)) as {
    entries: Array<Record<string, unknown>>;
    unresolvedNodes: string[];
    stats: { total: number; resolved: number; unresolved: number };
  };

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]?.nodeKey, "SolNode94");
  assert.equal(result.entries[0]?.node, "Apollodorus");
  assert.equal(result.entries[0]?.nodeZh, "阿波罗多罗斯");
  assert.equal(result.entries[0]?.planet, "Mercury");
  assert.equal(result.entries[0]?.planetZh, "水星");
  assert.equal(result.entries[0]?.missionType, "SURVIVAL");
  assert.equal(result.entries[0]?.faction, "Infestation");
  assert.equal(result.entries[0]?.activation, "2024-10-02T16:00:00.000Z");
  assert.equal(result.entries[0]?.expiry, "2024-10-02T17:00:00.000Z");
  assert.equal(result.entries[0]?.id, "arbys:1727884800");

  // 未知节点记入 unresolvedNodes，不整批失败
  assert.deepEqual(result.unresolvedNodes, ["UnknownNode999"]);
  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.resolved, 2);
  assert.equal(result.stats.unresolved, 1);
});

test("rejects arbys.txt without nodes codebook", () => {
  const rawFile = raw("arbitration/arbys.txt", "1727884800,SolNode94\n", source("browse.wf", "arbitration-schedule"));
  assert.throws(
    () => projectArbitrationSchedule(rawFile, []),
    /requires worldstate nodes codebook/u,
  );
});
