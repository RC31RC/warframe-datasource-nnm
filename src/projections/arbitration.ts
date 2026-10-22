import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

const NODES_PATH = "worldstate/nodes.json";

/**
 * 仲裁小时排期投影：把 arbys.txt（`epochSeconds,nodeReference`）解析为可读排期行。
 *
 * 依赖 worldstate 代码簿（nodes.json）——节点键解析为可读名 + 任务类型 + 阵营 + 星系，
 * 因此本投影必须在 worldstate 代码簿生成之后运行（编排上属于解析层）。
 * 未知节点不导致整批失败，记入 unresolvedNodes 供追溯。
 */
export function projectArbitrationSchedule(
  rawFile: DatasetFileInput,
  worldstateFiles: DatasetFileInput[],
): DatasetFileInput[] {
  const nodesFile = worldstateFiles.find((f) => f.path === NODES_PATH);
  if (!nodesFile) throw new Error("Arbitration schedule requires worldstate nodes codebook");
  const nodes = parseObject(nodesFile) as Record<string, JsonObject>;

  const text = Buffer.isBuffer(rawFile.content)
    ? rawFile.content.toString("utf8")
    : rawFile.content;

  const entries: JsonObject[] = [];
  const unresolvedNodes = new Set<string>();
  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/u)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;
    const columns = line.split(",", -1);
    if (columns.length !== 2) throw new Error(`Invalid arbys.txt line ${lineNumber}`);
    const epochSeconds = Number(columns[0]?.trim());
    const nodeKey = (columns[1] ?? "").trim();
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0 || nodeKey === "") {
      throw new Error(`Invalid arbys.txt line ${lineNumber}`);
    }
    const node = nodes[nodeKey];
    if (!node) {
      unresolvedNodes.add(nodeKey);
      continue;
    }
    const activation = new Date(epochSeconds * 1000);
    const expiry = new Date((epochSeconds + 3600) * 1000);
    entries.push({
      id: `arbys:${epochSeconds}`,
      activation: activation.toISOString(),
      expiry: expiry.toISOString(),
      nodeKey,
      node: textOf(node, "name") ?? nodeKey,
      nodeZh: textOf(node, "nameZh") ?? "",
      missionType: textOf(node, "missionTypeName") ?? textOf(node, "missionType") ?? "",
      missionTypeZh: textOf(node, "missionTypeNameZh") ?? "",
      faction: textOf(node, "factionName") ?? textOf(node, "faction") ?? "",
      factionZh: textOf(node, "factionNameZh") ?? "",
      planet: textOf(node, "systemName") ?? "",
      planetZh: textOf(node, "systemNameZh") ?? "",
    });
  }
  if (entries.length === 0) throw new Error("arbys.txt contains no resolvable schedule rows");

  const value = {
    entries,
    unresolvedNodes: [...unresolvedNodes],
    stats: { total: entries.length + unresolvedNodes.size, resolved: entries.length, unresolved: unresolvedNodes.size },
  };
  const capturedAt = rawFile.source.capturedAt;
  return [{
    stage: "cleaned",
    path: "arbitration/schedule.json",
    content: `${JSON.stringify(value, null, 2)}\n`,
    recordCount: entries.length,
    source: {
      project: "warframe-datasource-nnm",
      dataset: "arbitration/schedule.json",
      url: rawFile.source.url,
      capturedAt,
      upstreamRevision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      transformer: "warframe-datasource-nnm/arbitration-schedule-projection@1",
      derivedFrom: [rawFile.path, NODES_PATH],
    },
  }];
}

function parseObject(file: DatasetFileInput): JsonObject {
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object in ${file.path}`);
  }
  return value as JsonObject;
}

function textOf(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
