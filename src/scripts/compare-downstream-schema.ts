import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { previewRedundantMissions } from "../analysis/redundant-missions.js";
import { analyzeProductStructure } from "../analysis/product-structure.js";

/** Execute the consumer's real planner, intercepting every write and supplying read adapters in memory. */
const botRoot = resolve(process.argv[2] ?? "../NnmBot");
const directory = resolve(process.argv[3] ?? "data/latest");
const output = resolve(process.argv[4] ?? "docs/downstream-schema-comparison");
const before = process.argv[5] ? resolve(process.argv[5]) : undefined;
const generator = join(botRoot, "scripts/database/generate-official-product-models.cjs");
const source = readFileSync(generator, "utf8");
const require = createRequire(generator);
type Contract = { buildId: string; roots: Record<string, string>; models: { domain: string; table: string; path: string }[] };
let contract: Contract | undefined;
let activeDirectory = directory;
let previewMissions = false;
const modelDirectory = resolve(botRoot, "nnm-warframe/src/main/java/com/nnm/bot/warframe/model/entity/official/product");
const domainFile = join(botRoot, "nnm-warframe/src/main/java/com/nnm/bot/warframe/constant/WarframeOfficialDataDomain.java");
const extraDomains = '\n    LANGUAGE_STRING("reference/language-strings.json"\n    ABILITY_OWNER_LOCALIZATION("reference/ability-owner-localizations.json"\n    UPGRADE_LOCALIZATION("reference/upgrade-localizations.json"\n';
const domainSource = readFileSync(domainFile, "utf8") + extraDomains;
const readonlyFs = {
  readFileSync(path: string, encoding: string) {
    if (resolve(String(path)) === domainFile) return domainSource;
    const content = readFileSync(path, encoding as "utf8");
    if (previewMissions && resolve(String(path)) === join(activeDirectory, "world/tilesets.json")) {
      const preview = previewRedundantMissions(JSON.parse(String(content)));
      if (preview.checked !== preview.removable) throw new Error("Incomplete mission coverage");
      return JSON.stringify(preview.value);
    }
    return content;
  },
  mkdirSync() {},
  readdirSync(path: string, ...args: unknown[]) {
    if (resolve(String(path)) === modelDirectory) return [];
    return (readdirSync as (...args: unknown[]) => unknown)(path, ...args);
  },
  writeFileSync(path: string, data: string) {
    if (String(path).endsWith("/official-product-models.json")) contract = JSON.parse(data) as Contract;
  },
  unlinkSync() { throw new Error("Readonly planner attempted to delete a file"); },
};
const runPlanner = (code: string, root = directory): Contract => {
  activeDirectory = root; contract = undefined;
  runInNewContext(code, {
    require: (id: string) => {
      if (id === "node:fs" || id === "fs") return readonlyFs;
      if (id === "node:path" || id === "node:crypto") return require(id);
      throw new Error(`Readonly planner does not allow module ${id}`);
    },
    __dirname: dirname(generator), process: { argv: ["node", generator, root] }, console: { log() {} }, Buffer,
  }, { filename: generator, timeout: 120_000 });
  if (!contract) throw new Error("Consumer planner did not emit a contract");
  return contract;
};
// Fixed field access only. No record reconstruction, content removal or new table-sharing heuristics.
const adaptedSource = source
  .replaceAll("document.conquests[name]", 'document[`conquests__${name}`]')
  .replaceAll("document.conquests.missionVariants", 'document["conquests__missionVariants"]')
  .replaceAll("document.descents[name]", 'document[`descents__${name}`]')
  .replace("{ quality: document.quality, unresolvedMarketWeapons: document.unresolvedMarketWeapons }",
    "Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'weapons'))");
let unmodifiedPlannerError: string | null = null;
try { runPlanner(source); } catch (error) { unmodifiedPlannerError = String(error); }
const planned = runPlanner(adaptedSource);
const baseline = before ? runPlanner(adaptedSource, before) : undefined;
previewMissions = true;
const withoutMissions = before ? runPlanner(adaptedSource, before) : undefined;
previewMissions = false;
const existing = JSON.parse(readFileSync(join(botRoot, "nnm-warframe/src/main/resources/warframe/official-product-models.json"), "utf8")) as Contract;
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { buildId: string; files: { path: string }[] };
const domains = new Map([...domainSource.matchAll(/^    ([A-Z_0-9]+)\("([^"]+\.json)"/gm)].map((match) => [match[2]!, match[1]!]));
const count = (models: Contract["models"], domain: string) => models.filter((model) => model.domain === domain).length;
const published = new Set(manifest.files.map(({ path }) => path));
const paths = [...new Set([...published, ...domains.keys()])].sort();
const rows = paths.map((path) => {
  const domain = domains.get(path); if (!domain) throw new Error(`Unknown consumer domain: ${path}`);
  const structuralRelationPaths = published.has(path) ? analyzeProductStructure(JSON.parse(readFileSync(join(directory, path), "utf8")), path).tables : 0;
  return { file: path, domain, published: published.has(path), structuralRelationPaths,
    existingConsumerTables: count(existing.models, domain), baselinePlannerTables: baseline ? count(baseline.models, domain) : null,
    baselineWithoutMissions: withoutMissions ? count(withoutMissions.models, domain) : null,
    currentPlannerTables: count(planned.models, domain) };
});
const report = { readOnly: true, buildId: manifest.buildId, existingConsumerBuildId: existing.buildId,
  unmodifiedPlannerError, requiredReadAdaptations: ["ACTIVITY: conquests__/descents__ direct field access", "RIVEN_WEAPON: promoted quality__* fields",
    "Register LANGUAGE_STRING, ABILITY_OWNER_LOCALIZATION and UPGRADE_LOCALIZATION domains", "Read zhName/zhDescription and bilingual child fields directly", "ENEMY: avatarTypes[] with singular reference__* fields"],
  planner: generator, plannerSha256: require("node:crypto").createHash("sha256").update(source).digest("hex"),
  totals: { structuralRelationPaths: rows.reduce((sum, row) => sum + row.structuralRelationPaths, 0), existingConsumerTables: existing.models.length,
    baselinePlannerTables: baseline?.models.length ?? null, baselineWithoutMissions: withoutMissions?.models.length ?? null,
    currentPlannerTables: planned.models.length }, rows };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${output}.md`, ["# NnmBot 实际规划器只读对照", "", `当前成品：${manifest.buildId}`, `NnmBot 已有契约：${existing.buildId}`, "",
  "数据源结构已调整；本脚本不修改 NnmBot 文件。ACTIVITY/RIVEN_WEAPON 字段访问与三个新领域注册只在内存中适配，其余沿用真实规划器规则。当前表数是适配后预演；不代表消费端已经迁移或发布。结构路径计数不等于物理表数。缺少 before 参数时不重建历史基准。", "",
  "| 文件 | 结构路径 | 现存契约 | 基准规划 | 基准仅去 missions | 当前规划 |", "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map((row) => `| ${row.file} | ${row.structuralRelationPaths} | ${row.existingConsumerTables} | ${row.baselinePlannerTables ?? '—'} | ${row.baselineWithoutMissions ?? '—'} | ${row.currentPlannerTables} |`),
  `| **合计** | **${report.totals.structuralRelationPaths}** | **${existing.models.length}** | **${baseline?.models.length ?? '—'}** | **${withoutMissions?.models.length ?? '—'}** | **${planned.models.length}** |`, "",
].join("\n"));
console.log(JSON.stringify({ readOnly: true, buildId: report.buildId, ...report.totals }));
