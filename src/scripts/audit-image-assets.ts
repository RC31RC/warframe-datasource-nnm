import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "data/latest");
const target = process.argv[3] ?? "/Lotus/Interface/Icons/Npcs/Neutral/CondrocCommon.png";
const output = resolve(process.argv[4] ?? "docs/image-asset-diagnostic.json");
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { buildId: string; files: { path: string }[] };
const images = JSON.parse(await readFile(join(directory, "reference/images.json"), "utf8")) as Record<string, unknown>;
const matches: Record<string, unknown>[] = [];
const statuses = new Map<string, number>();
const visit = (value: unknown, file: string, path: string[]) => {
  if (Array.isArray(value)) { value.forEach((row, index) => visit(row, file, [...path, String(index)])); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (/(?:^|__)iconStatus$/u.test(key) && typeof child === "string") statuses.set(child, (statuses.get(child) ?? 0) + 1);
    if (child === target && /(?:^|__)(?:icon|iconAsset|iconTexture|abilityIconUrl)$/u.test(key)) {
      const prefix = key.includes("__") ? key.slice(0, key.lastIndexOf("__") + 2) : "";
      matches.push({ file, path: [...path, key].join("."), nameZh: record[`${prefix}nameZh`], iconStatus: record[`${prefix}iconStatus`], iconUrl: record[`${prefix}iconUrl`] ?? null });
    }
    visit(child, file, [...path, key]);
  }
};
for (const file of manifest.files) {
  if (file.path.startsWith("reference/language-")) continue;
  visit(JSON.parse(await readFile(join(directory, file.path), "utf8")), file.path, []);
}
const entry = images[target] ?? images[target.replace(/^\//u, "")] ?? null;
const report = { buildId: manifest.buildId, target, publicImageEntry: entry, hasPublicMapping: entry !== null,
  matches, iconStatusOccurrences: Object.fromEntries(statuses),
  conclusion: entry ? "Inspect the exact contentHash/mapping; an index entry alone is not an HTTP availability check."
    : "Internal game asset path, not a public URL. No mapping in the current public image manifest; no verified CDN URL can be built. ExportImages only transposes ExportManifest, it does not export all game textures. Need an authoritative public mapping or actual asset export/hosting. Do not substitute the tag/plush icon by name." };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ target, publicMapping: report.hasPublicMapping, matchedFields: matches.length, output }));
