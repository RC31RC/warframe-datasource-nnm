import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { analyzeProductStructure, type ProductStructure } from "../analysis/product-structure.js";
import { logicalProductPath, parseGzipJson } from "../publish/dataset-reader.js";

const directory = resolve(process.argv[2] ?? "data/latest");
const beforeDirectory = process.argv[3] ? resolve(process.argv[3]) : undefined;
const output = resolve(process.argv[4] ?? "docs/json-structure-report");
const manifest = parseGzipJson<{ buildId: string; files: { path: string }[] }>(await readFile(join(directory, "manifest.json.gz")));
const beforeManifest = beforeDirectory
  ? parseGzipJson<typeof manifest>(await readFile(join(beforeDirectory, "manifest.json.gz"))) : manifest;
const afterPaths = new Set(manifest.files.map((entry) => entry.path));
const beforePaths = new Set(beforeManifest.files.map((entry) => entry.path));
const paths = [...new Set([...afterPaths, ...beforePaths])].sort();
const empty = (): ProductStructure => ({ recordDepth: 0, tables: 0, tablePaths: [], scalarLeaves: 0, arrays: 0 });
const rows: { file: string; before: ProductStructure; after: ProductStructure }[] = [];
for (const path of paths) {
  const after = afterPaths.has(path) ? analyzeProductStructure(parseGzipJson(await readFile(join(directory, path))), logicalProductPath(path)) : empty();
  const before = beforePaths.has(path) ? (beforeDirectory
    ? analyzeProductStructure(parseGzipJson(await readFile(join(beforeDirectory, path))), logicalProductPath(path)) : after) : empty();
  rows.push({ file: path, before, after });
}
const total = (side: "before" | "after") => rows.reduce((n, row) => n + row[side].tables, 0);
const report = { metric: "structural-relation-paths-not-ddl", buildId: manifest.buildId, convention: "Structural relation-path count only (not consumer DDL or an upper/lower bound), by distinct field/collection path, including scalar arrays, keyed maps and document metadata; recursive groups share one self-referencing table; no cross-file table sharing; manifest excluded. Counts are a schema estimate from present fields, not a final SQL design.",
  totals: { products: manifest.files.length, beforeProducts: beforeManifest.files.length, beforeTables: total("before"), afterTables: total("after") }, rows };
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${output}.md`, ["# 成品 JSON 层级与结构路径计数", "", `构建：${manifest.buildId}`, "",
  "口径：根记录为第 1 层；固定一对一对象合并后不再占层级。数组/键值集合保留；所有多值字段（含标量数组）、尚未确认的一对一对象、文档元信息均独立计表；不同文件/字段路径不共表；递归 groups 按一张带 parent_id 的表计数。manifest 不计。", "",
  "这不是 NnmBot 建表数量，也不是其上下界。消费者会重组根记录、内联单对象，并自行判定字典/数组。实际 DDL 对照请运行 npm run compare:downstream，见 docs/downstream-schema-comparison.md。", "",
  "| JSON | 基准记录层级 | 当前记录层级 | 基准结构路径数 | 当前结构路径数 |", "| --- | ---: | ---: | ---: | ---: |",
  ...rows.map((row) => `| \`${row.file}\` | ${row.before.recordDepth} | ${row.after.recordDepth} | ${row.before.tables} | ${row.after.tables} |`),
  `| **合计** | — | — | **${total("before")}** | **${total("after")}** |`, "",
].join("\n"));
console.log(JSON.stringify(report.totals));
