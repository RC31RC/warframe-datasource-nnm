import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { collectOfficialMedia } from "../collectors/official-media.js";
import { collectPublicExport } from "../collectors/public-export.js";
import { collectMarketItems, collectRivenAttributes, collectRivenWeapons } from "../collectors/market.js";
import { collectPlusExports } from "../collectors/plus.js";
import { collectDropTables } from "../collectors/droptables.js";
import { collectUsageData } from "../collectors/usage.js";
import { collectLanguagesBinData } from "../collectors/languages.js";
import type { DatasetFileInput } from "../domain/contracts.js";

type Entry = Omit<DatasetFileInput, "content"> & { sha256: string };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Freeze acquired inputs before projection, so failed builds can be replayed without more network calls. */
export async function acquire(directory: string): Promise<DatasetFileInput[]> {
  await mkdir(directory, { recursive: true });
  const jobs = [
    ["public-export", () => collectPublicExport()], ["market-items", () => collectMarketItems()],
    ["riven-attributes", () => collectRivenAttributes()], ["riven-weapons", () => collectRivenWeapons()],
    ["plus", () => collectPlusExports()],
    ["official-media", () => collectOfficialMedia()], ["drops", () => collectDropTables()], ["usage", () => collectUsageData()],
    ["languages", () => collectLanguagesBinData()],
  ] as const;
  const results = await Promise.allSettled(jobs.map(async ([name, collect]) => {
    const jobIndex = join(directory, `${name}.index.json`);
    try { return await loadIndex(directory, jobIndex); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    console.log(`Acquiring ${name}`);
    const files = await collect();
    const index: Entry[] = [];
    for (const { content, ...file } of files) {
      const bytes = Buffer.from(content);
      const target = join(directory, file.stage, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      index.push({ ...file, sha256: hash(bytes) });
    }
    await writeFile(jobIndex, JSON.stringify(index, null, 2));
    console.log(`Acquired ${name}: ${files.length} inputs`);
    return files;
  }));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
  if (errors.length) throw new AggregateError(errors, `Acquisition incomplete; resumable inputs: ${directory}`);
  const files = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  await writeFile(join(directory, "inputs.json"), JSON.stringify(files.map(({ content, ...file }) => ({ ...file, sha256: hash(Buffer.from(content)) })), null, 2));
  return files;
}

export async function loadInputs(directory: string): Promise<DatasetFileInput[]> {
  return loadIndex(directory, join(directory, "inputs.json"));
}

/**
 * 成功发布后清理自动生成的冻结输入目录。
 *
 * 只处理 tmpDirectory 下的 `inputs-*`，避免误删用户显式指定的外部目录。
 * 采集失败时 CLI 不会调用此函数，因此失败现场仍可用于 replay/重试。
 */
export async function cleanupCollectedInputs(directory: string, tmpDirectory: string, keep = false): Promise<void> {
  if (keep) return;
  const inputDirectory = resolve(directory);
  const temporaryDirectory = resolve(tmpDirectory);
  const relativePath = relative(temporaryDirectory, inputDirectory);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || basename(inputDirectory).startsWith("inputs-") === false) return;
  await rm(inputDirectory, { recursive: true, force: true });
}

async function loadIndex(directory: string, path: string): Promise<DatasetFileInput[]> {
  const entries = JSON.parse(await readFile(path, "utf8")) as Entry[];
  return Promise.all(entries.map(async ({ sha256, ...file }) => {
    if (!/^(raw|cleaned)$/u.test(file.stage) || file.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Invalid input path: ${file.path}`);
    const content = await readFile(join(directory, file.stage, file.path));
    if (hash(content) !== sha256) throw new Error(`Frozen input checksum mismatch: ${file.path}`);
    return { ...file, content };
  }));
}
