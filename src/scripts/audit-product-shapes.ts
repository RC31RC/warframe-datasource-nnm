import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { analyzeProductShapes } from "../analysis/product-shapes.js";
import type { DatasetManifest } from "../domain/contracts.js";
const directory = resolve(process.argv[2] ?? "data/latest");
const before = process.argv[3] ? resolve(process.argv[3]) : undefined;
const output = resolve(process.argv[4] ?? "docs/product-record-shapes");
function audit(root: string) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as DatasetManifest;
  const rows = manifest.files.map(({ path }) => ({ file: path,
    ...analyzeProductShapes(JSON.parse(readFileSync(join(root, path), "utf8")), path) }));
  return { buildId: manifest.buildId, totals: { files: rows.length,
    filesWithMixedTypes: rows.filter((row) => row.mixedTypes.length).length,
    mixedTypePaths: rows.reduce((sum, row) => sum + row.mixedTypes.length, 0),
    filesWithVaryingFieldSets: rows.filter((row) => row.varyingFieldSets.length).length,
    varyingFieldSetPaths: rows.reduce((sum, row) => sum + row.varyingFieldSets.length, 0) }, rows };
}
const report = { current: audit(directory), before: before ? audit(before) : null,
  interpretation: "Different optional field sets can share a typed Java DTO with nullable fields; mixed non-null JSON types require explicit normalization or separate contracts. A document containing distinct named sections is not a mixed record collection." };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + "\n");
writeFileSync(`${output}.md`, ["# 成品记录类型审计", "", report.interpretation, "", "```json", JSON.stringify({ before: report.before?.totals, current: report.current.totals }, null, 2), "```", "",
  "| 文件 | 同字段多类型路径 | 可选字段组合不同的路径 |", "| --- | ---: | ---: |",
  ...report.current.rows.map((row) => `| ${row.file} | ${row.mixedTypes.length} | ${row.varyingFieldSets.length} |`), "", "详细字段与类型见同名 JSON。", ""].join("\n"));
console.log(JSON.stringify({ before: report.before?.totals, current: report.current.totals }));
if (report.current.totals.mixedTypePaths) process.exitCode = 1;
