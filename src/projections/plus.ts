import type { DatasetFileInput } from "../domain/contracts.js";
import { canonicalIdentity, identityDetails, object, read } from "./identity.js";
import { drawMechanism } from "./probability.js";

type Obj = Record<string, unknown>;
const IDENTITY_FIELDS = new Set(["uniqueName", "recordKey", "gameRef", "nodeKey", "icon", "iconAsset", "iconTexture", "abilityUniqueName", "name", "nameEn", "nameZh", "nameKey", "description", "descriptionEn", "descriptionZh", "descriptionKey", "image", "textureLocation"]);

/** Resolve both catalog items and exact gameplay identities, with bounded references. */
export function enrichPlusReferences(plusFiles: DatasetFileInput[], catalogFiles: DatasetFileInput[]): DatasetFileInput[] {
  const byIdentity = identityDetails([...catalogFiles, ...plusFiles]);
  const rewardFile = plusFiles.find((file) => file.path === "plus/rewards.json");
  const rewardPools = rewardFile ? object(read(rewardFile)) : {};
  // Expand pool members once; pool-to-pool references remain bounded identities.
  const poolDefinition = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(poolDefinition);
    if (!value || typeof value !== "object") return value;
    const row = object(value), id = typeof row.type === "string" ? row.type : "";
    const item = id ? byIdentity.get(canonicalIdentity(id)) : undefined;
    return { ...row, ...(id ? { item: { uniqueName: canonicalIdentity(id), ...(item ?? {}),
      resolution: item?.name || item?.nameZh ? "localized_identity" : "identity_only" } } : {}) };
  };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Obj, next: Obj = {}, references: Obj[] = [];
    for (const [key, child] of Object.entries(record)) {
      next[key] = key === "itemReferences" ? child : visit(child);
      if (IDENTITY_FIELDS.has(key) || typeof child !== "string" || !child.startsWith("/Lotus/") || child.startsWith("/Lotus/Language/")) continue;
      const pool = rewardPools[child] ?? rewardPools[canonicalIdentity(child)];
      if (Array.isArray(pool)) {
        references.push({ field: key, uniqueName: child, referenceKind: "reward_pool",
          resolution: "exact_reward_pool", rotations: poolDefinition(pool), probabilityUnit: "fraction" });
        continue;
      }
      const details = byIdentity.get(canonicalIdentity(child));
      references.push(details ? { field: key, ...details, resolution: details.name || details.nameZh ? "localized_identity" : "stable_identity_only" }
        : { field: key, uniqueName: child, name: "", nameZh: "", resolution: "identity_only",
          referenceKind: /Types\/(?:Items|Recipes)|Upgrades\/Mods|Weapons\//u.test(child) ? "item" : "gameplay" });
    }
    if (Array.isArray(record.stages)) {
      const stageReference = (value: unknown): unknown => Array.isArray(value) ? value.map(stageReference) : typeof value === "string" && value.startsWith("/Lotus/")
        ? { uniqueName: value, ...(byIdentity.get(canonicalIdentity(value)) ?? {}), resolution: byIdentity.has(canonicalIdentity(value)) ? "exact_identity" : "unresolved" } : value;
      next.stageReferences = record.stages.map(stageReference);
    }
    if (references.length) next.itemReferences = references;
    if (typeof record.chance === "number" && Array.isArray(record.items) && record.items.some((item) => typeof object(item).probability === "number")) {
      const { chance: _chance, ...withoutChance } = next;
      return { ...withoutChance, ...drawMechanism(record.chance), probabilityUnit: "fraction" };
    }
    return next;
  };
  return plusFiles.map((file) => file.stage !== "cleaned" || file.path.startsWith("languages/") || file.path === "plus/images.json" ? file : {
    ...file, content: `${JSON.stringify(visit(read(file)), null, 2)}\n`,
  });
}
