import type { DatasetFileInput } from "../domain/contracts.js";
import { canonicalIdentity, object, read } from "./identity.js";

type Obj = Record<string, unknown>;
export type RewardEvidence = { uniqueName: string; probability?: number; count: number; poolType?: string };
export type RewardEvidenceIndex = { awarded: Set<string>; bySource: Map<string, RewardEvidence[]>; pools: RewardEvidence[][] };
const nameKey = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

/** Relationships present in the client exports: source → drop table or pack → concrete awards. */
export function rewardEvidence(files: DatasetFileInput[]): RewardEvidenceIndex {
  const entities = new Map<string, Obj>();
  const definitions = new Map<string, unknown>();
  const awarded = new Set<string>();
  const bySource = new Map<string, RewardEvidence[]>();
  const pools: RewardEvidence[][] = [];
  const rewards = (value: unknown, poolType?: string): RewardEvidence[] => {
    if (Array.isArray(value)) return value.flatMap((entry) => rewards(entry, poolType));
    const row = object(value), id = row.Item ?? row.type;
    if (typeof id === "string" && id.startsWith("/Lotus/") && !id.includes("/RESOLUTION_FAILURE/")) {
      const probability = row.Probability ?? row.probability;
      if (typeof probability !== "number") return [];
      const uniqueName = canonicalIdentity(id);
      awarded.add(uniqueName);
      return [{ uniqueName, probability, count: Number(row.Amount ?? row.itemCount ?? 1), ...(poolType ? { poolType } : {}) }];
    }
    return Object.entries(row).flatMap(([key, child]) => rewards(child,
      key === "items" && typeof row.type === "string" ? row.type : poolType));
  };
  for (const file of files) {
    if (file.stage !== "cleaned" || !file.path.startsWith("plus/")) continue;
    const root = read(file);
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      for (const [key, child] of Object.entries(object(value))) {
        if (key.startsWith("/Lotus/")) {
          definitions.set(canonicalIdentity(key), child);
          if (!Array.isArray(child)) entities.set(canonicalIdentity(key), object(child));
        }
        visit(child);
      }
    };
    visit(root);
    if (file.path === "plus/rewards.json") {
      const visitPools = (value: unknown) => {
        if (Array.isArray(value)) {
          if (value.length && value.every((entry) => typeof object(entry).type === "string" && typeof object(entry).probability === "number")) pools.push(rewards(value));
          else value.forEach(visitPools);
        } else Object.values(object(value)).forEach(visitPools);
      };
      visitPools(root);
    }
    if (/\/(?:rewards|enemies|boosterpacks)\.json$/u.test(file.path)) rewards(root);
  }
  const add = (name: unknown, entries: RewardEvidence[]) => {
    if (typeof name !== "string" || !name || name.startsWith("/") || !entries.length) return;
    const key = nameKey(name);
    bySource.set(key, [...(bySource.get(key) ?? []), ...entries]);
  };
  for (const [id, value] of definitions) {
    const entity = entities.get(id);
    if (!entity) {
      // The official SortieRewards manifest corresponds to the HTML source “Sortie”.
      const basename = id.split("/").pop() ?? "";
      if (basename.endsWith("Rewards")) add(basename.slice(0, -7), rewards(value));
      continue;
    }
    const droptable = typeof entity.droptable === "string" ? definitions.get(canonicalIdentity(entity.droptable)) : undefined;
    const entries = [...rewards(droptable), ...rewards(entity.components)];
    add(entity.nameEn ?? entity.name, entries);
  }
  return { awarded, bySource, pools };
}

/** Match inside an explicitly linked source pool; equal probability alone is never a global identity key. */
export function sourceRewards(index: RewardEvidenceIndex, source: string, category: string): RewardEvidence[] {
  const entries = index.bySource.get(nameKey(source)) ?? [];
  const type = ({ "Additional Item Drops by Source": "additionalItem", "Sigil Drops by Source": "sigil", "Blueprint/Item Drops by Source": "blueprint", "Resource Drops by Source": "resource", "Mod Drops by Source": "mod" } as Record<string, string>)[category];
  return entries.filter((entry) => !type || !entry.poolType || entry.poolType === type);
}
