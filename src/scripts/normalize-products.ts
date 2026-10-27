import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import type { DatasetManifest, DatasetFileInput } from "../domain/contracts.js";
import { DatasetPublisher } from "../publish/dataset-publisher.js";
import { finalizeBilingualProducts } from "../projections/bilingual.js";

// Migrate the verified frozen product snapshot without reacquiring or modifying tmp/cache.
const directory = resolve(process.argv[2] ?? "data/latest");
const publisher = new DatasetPublisher(dirname(directory), resolve("tmp"));
await publisher.verify();
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as DatasetManifest;
const inputs = await Promise.all(manifest.files.map(async (entry): Promise<DatasetFileInput> => {
  return { stage: "cleaned", path: entry.path, content: await readFile(join(directory, entry.path)), source: entry.source ?? { project: "verified local product snapshot", dataset: entry.path, url: new URL(`file://${join(directory, entry.path)}`).href, capturedAt: manifest.createdAt, upstreamRevision: entry.sha256 },
    ...(entry.recordCount === undefined ? {} : { recordCount: entry.recordCount }) };
}));
const files = finalizeBilingualProducts(inputs);
const second = finalizeBilingualProducts(files);
if (files.length !== second.length || files.some((file, i) => file.path !== second[i]?.path || String(file.content) !== String(second[i]?.content))) {
  throw new Error("Product normalization is not idempotent");
}
const result = await publisher.publish(files);
console.log(JSON.stringify({ beforeBuildId: manifest.buildId, buildId: result.manifest.buildId, files: result.manifest.files.length }));
