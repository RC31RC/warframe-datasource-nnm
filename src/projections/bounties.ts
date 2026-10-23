import type { DatasetFileInput } from "../domain/contracts.js";
import { object, read } from "./identity.js";

type Obj = Record<string, unknown>;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const countRewards = (value: unknown): number => {
  const row = object(value);
  return array(row.rewards).length + array(row.groups).reduce<number>((n, child) => n + countRewards(child), 0);
};

/** 赏金任务定义与分等级、轮次、阶段的掉落池归于同一业务文件，不据此推算当期任务。 */
export function consolidateBounties(files: DatasetFileInput[]): DatasetFileInput[] {
  const bountyFile = files.find((file) => file.path === "plus/bounties.json");
  const dropFile = files.find((file) => file.path === "drop/tables.json");
  if (!bountyFile || !dropFile) return files;
  const drops = object(read(dropFile));
  const rewardPools: Record<string, unknown[]> = {};
  const remaining: unknown[] = [];
  for (const value of array(drops.contexts)) {
    const row = object(value), category = String(row.category ?? "");
    if (category.endsWith("Bounty Rewards")) (rewardPools[category] ??= []).push(value);
    else remaining.push(value);
  }
  const definitions = object(read(bountyFile));
  const quality = { ...object(drops.quality), sourceContextCount: remaining.length,
    rewardCount: remaining.reduce<number>((n, context) => n + countRewards(context), 0) };
  const identity = { unique: 0, ambiguous: 0, unresolved: 0, categories: 0, rules: 0, currencies: 0 };
  const tally = (value: unknown): void => {
    const row = object(value);
    for (const reward of array(row.rewards)) {
      const resolution = object(object(reward).item).identityResolution;
      const key = ({ unique: "unique", ambiguous: "ambiguous", category: "categories", rule: "rules", currency: "currencies" } as const)[String(resolution) as "unique"] ?? "unresolved";
      identity[key] += 1;
    }
    array(row.groups).forEach(tally);
  };
  remaining.forEach(tally);
  return files.map((file) => file === bountyFile ? { ...file,
    content: `${JSON.stringify({ definitions, rewardPools }, null, 2)}\n`,
    recordCount: Object.keys(definitions).length + Object.values(rewardPools).reduce((n, pools) => n + pools.length, 0),
    source: { ...file.source, derivedFrom: [...new Set([...(file.source.derivedFrom ?? []), dropFile.path])] },
  } : file === dropFile ? { ...file,
    content: `${JSON.stringify({ ...drops, contexts: remaining, quality: { ...quality, itemIdentity: identity },
      bountyCatalog: "rewards/bounties.json" }, null, 2)}\n`, recordCount: quality.rewardCount,
  } : file);
}
