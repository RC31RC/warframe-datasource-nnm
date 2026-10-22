import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { config } from "../core/config.js";
import { fetchBytes } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

/**
 * Plus 数据族：官方 Public Export 没有、需 Pluto 工具链从游戏资源提取的数据。
 *
 * 输出分两阶段：
 * - raw：所有 Export*.json 原样快照，写入 tmp/<ts>/plus/（含重叠域，作输入素材）。
 * - cleaned：官方 Export 没有的独有域透传发布，写入 data/<date>/plus/。
 *
 * 数据获取采用降级链（生产路径，见 acquirePlusFiles）：
 *   1. 有 Warframe 游戏 → Pluto 提取链（阶段 C，待实现）
 *   2. 无游戏 → 从成品仓库 GitHub Raw 拉取
 *   3. Raw 失败 → 从 tmp 最近一次含 plus 的快照拷贝（上一次采集的数据）
 */

/** 官方 Export 没有的独有域，直接透传发布。 */
const EXCLUSIVE_EXPORTS = [
  "Achievements",
  "Animals",
  "BoosterPacks",
  "Boosters",
  "Bounties",
  "Bundles",
  "Challenges",
  "Codex",
  "CreditBundles",
  "EmailItems",
  "Enemies",
  "Factions",
  "Images",
  "Intrinsics",
  "MissionTypes",
  "Nightwave",
  "Rewards",
  "Syndicates",
  "Systems",
  "TextIcons",
  "Tilesets",
  "Vendors",
  "Virtuals",
] as const;

/** plus 仓库全部 Export 数据族（独有域 + 与官方重叠域），作 raw 快照的完整清单。 */
const ALL_PLUS_EXPORTS = [
  "Abilities", "Achievements", "Animals", "Arcanes", "Avionics",
  "BoosterPacks", "Boosters", "Bounties", "Bundles", "Challenges",
  "Codex", "CreditBundles", "Customs", "DojoRecipes", "Drones",
  "EmailItems", "Enemies", "Factions", "Flavour", "FocusUpgrades",
  "FusionBundles", "Gear", "Images", "Intrinsics", "Keys",
  "MissionTypes", "ModSet", "Nightwave", "RailjackWeapons", "Recipes",
  "Regions", "Relics", "Resources", "Rewards", "Sentinels",
  "Syndicates", "Systems", "TextIcons", "Tilesets", "Upgrades",
  "Vendors", "Virtuals", "Warframes", "Weapons",
] as const;

const UPSTREAM_REPOSITORY = "https://github.com/calamity-inc/warframe-public-export-plus";

export async function collectPlusExports(
  now = new Date(),
  sourceDirectory?: string,
  exclusiveNames: readonly string[] = EXCLUSIVE_EXPORTS,
): Promise<DatasetFileInput[]> {
  const capturedAt = now.toISOString();
  const output: DatasetFileInput[] = [];

  // 测试可注入 sourceDirectory 直接读本地目录；生产走降级链。
  const dataFiles = sourceDirectory !== undefined
    ? await readDirectoryFiles(sourceDirectory)
    : await acquirePlusFiles();

  // raw 阶段：快照全部 Export*.json。
  for (const fileName of [...dataFiles.keys()].sort()) {
    const name = fileName.slice("Export".length, -".json".length);
    const bytes = dataFiles.get(fileName);
    if (!bytes) throw new Error(`Missing raw-plus input for ${name}: ${fileName}`);
    parsePlusJson(bytes, name);
    output.push({
      stage: "raw",
      path: `plus/${fileName}`,
      content: bytes,
      source: {
        project: "warframe-public-export-plus",
        dataset: `plus/raw/${name}`,
        url: `${UPSTREAM_REPOSITORY}/blob/senpai/${fileName}`,
        capturedAt,
        upstreamRevision: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  }

  // cleaned 阶段：独有域透传发布。
  for (const name of exclusiveNames) {
    const fileName = `Export${name}.json`;
    const bytes = dataFiles.get(fileName);
    if (!bytes) throw new Error(`Missing raw-plus input for ${name}: ${fileName}`);
    const value = parsePlusJson(bytes, name);
    output.push({
      stage: "cleaned",
      path: `plus/${name.toLowerCase()}.json`,
      content: bytes,
      recordCount: countRecords(value, name),
      source: {
        project: "warframe-public-export-plus",
        dataset: `plus/${name}`,
        url: `${UPSTREAM_REPOSITORY}/blob/senpai/${fileName}`,
        capturedAt,
        upstreamRevision: createHash("sha256").update(bytes).digest("hex"),
        transformer: "warframe-datasource-nnm/plus-exclusive-pass-through@1",
        derivedFrom: [`plus/${fileName}`],
      },
    });
  }

  return output;
}

/**
 * 降级链获取 plus 数据文件。
 * 返回 Map<fileName, Buffer>，fileName 形如 `ExportEnemies.json`。
 */
async function acquirePlusFiles(): Promise<Map<string, Buffer>> {
  // 1. 有 Warframe 游戏 → Pluto 提取链（阶段 C，待实现）。
  if (config.warframeGameDir && await hasWarframeClient(config.warframeGameDir)) {
    // TODO(Pluto 阶段 C)：在此接入 plus-gen 的 index.pluto 从游戏资源提取，
    // 锁定运行时与游戏版本后转为完全自采。当前提取链未实现，降级到 raw。
    console.warn("检测到 Warframe 游戏目录，但 Pluto 提取链尚未实现，降级为从成品 raw 拉取");
  }

  // 2. 无游戏 → 从成品仓库 GitHub Raw 拉取。
  try {
    return await fetchPlusFromRaw();
  } catch (error) {
    console.warn(`从 GitHub Raw 拉取 plus 失败（${error instanceof Error ? error.message : error}），降级为从 tmp 上一次快照拷贝`);
  }

  // 3. Raw 失败 → 从 tmp/cache 解压上一轮的 plus 快照（失败则整体失败）。
  return copyPlusFromCache();
}

async function fetchPlusFromRaw(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  await mapLimit(ALL_PLUS_EXPORTS, 4, async (name) => {
    const fileName = `Export${name}.json`;
    const url = `${config.plusRawBaseUrl}/${fileName}`;
    const bytes = await fetchBytes(url, {
      timeoutMs: config.requestTimeoutMs,
      maxBytes: config.maxResponseBytes,
      retries: config.requestRetries,
    });
    files.set(fileName, bytes);
  });
  return files;
}

async function copyPlusFromCache(): Promise<Map<string, Buffer>> {
  const cacheDir = join(config.tmpDirectory, "cache", "plus");
  let names: string[];
  try {
    names = (await readdir(cacheDir)).filter((name) => name.endsWith(".gz"));
  } catch (error) {
    throw new Error(`tmp cache is missing plus snapshot: ${cacheDir}`, { cause: error });
  }
  if (names.length === 0) throw new Error(`tmp cache plus snapshot is empty: ${cacheDir}`);
  const files = new Map<string, Buffer>();
  for (const name of names) {
    const bytes = await readFile(join(cacheDir, name));
    files.set(name.slice(0, -".gz".length), gunzipSync(bytes));
  }
  return files;
}

async function readDirectoryFiles(directory: string): Promise<Map<string, Buffer>> {
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => /^Export[A-Za-z0-9]+\.json$/u.test(name))
      .sort();
  } catch (error) {
    throw new Error(`Missing raw-plus input directory: ${directory}`, { cause: error });
  }
  const files = new Map<string, Buffer>();
  for (const name of names) {
    files.set(name, await readFile(join(directory, name)));
  }
  return files;
}

async function hasWarframeClient(gameDir: string): Promise<boolean> {
  const markers = ["Warframe.x64.exe", "Launcher.exe", "Cache.Windows", "Tools"];
  for (const marker of markers) {
    if (await exists(join(gameDir, marker))) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit<T>(items: readonly T[], limit: number, mapper: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) throw new Error("Concurrent collection index out of range");
      await mapper(item);
    }
  });
  await Promise.all(workers);
}

function parsePlusJson(bytes: Buffer, name: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid raw-plus JSON for ${name}`, { cause: error });
  }
}

function countRecords(value: unknown, name: string): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object" && value !== null) {
    return Object.keys(value as Record<string, unknown>).length;
  }
  throw new Error(`raw-plus payload for ${name} must be an object or array`);
}
