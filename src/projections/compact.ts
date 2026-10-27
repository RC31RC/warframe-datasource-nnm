import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";
import { canonicalProductPath } from "../publish/product-layout.js";

type Obj = Record<string, unknown>;
/** A delimiter, not camel-case guessing: item.nameZh -> item__nameZh. */
export const FIELD_SEPARATOR = "__";

/**
 * Singular object contracts, NOT arrays that happen to contain one element.
 * Public Export: resultItem, item, media, mission, darkSectorData, miscItemFee.
 * Plus/client definitions: attacks, numeric ranges, sacrifices, messages, rewards.
 * Our projections: gameItem, source, reverseIndex, quality and reconciliation.
 * Unknown objects remain objects; new upstream fields are never flattened by guesswork.
 */
export const SINGLE_OBJECT_FIELDS = new Set([
  "attack", "impact", "explosiveAttack", "embedDeathAttack", "projectile", "chargedProjectile", "burst",
  "backgroundColour", "colour", "conservation", "count", "credits", "darkSectorData", "droneDamage",
  "durationHours", "focusXpCost", "gameItem", "helminthSnack", "initiationSacrifice", "item", "media",
  "message", "messageToSendWhenTriggered", "miscItemFee", "mission", "missionReward", "numItems",
  "pickupQuantity", "platinum", "resultItem", "reverseIndex", "reward", "sacrifice", "secretTransmission",
  "shardCategory", "stats", "statsZh", "syndicate", "syndicateStandingChange", "source", "quality",
  "itemIdentity", "reverseIndexReconciliation",
]);

/** Keyed collections retain their keys AND record boundaries, including single-member maps. */
export const RECORD_MAP_FIELDS = new Set([
  "states", "i18n", "translations", "missions", "alignments", "avatarTypes", "probabilities", "capacityMultipliers",
]);
export const SECTION_MAP_PRODUCTS = new Set([
  "crafting/dojo-recipes.json", "world/codex.json", "world/enemies.json",
]);
export const DOCUMENT_PRODUCTS = new Set([
  "world/star-chart.json", "rewards/bounties.json", "rewards/drop-tables.json", "rewards/relics.json",
  "upgrades/riven-weapons.json", "worldstate/activities.json", "progression/nightwave.json",
]);
const ACTIVITY_MAPS = new Set(["types", "conditions", "personalModifiers", "missionVariants", "challenges", "gameModes", "protoframes"]);
const obj = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);

export function isRecordMap(file: string, field: string): boolean {
  return RECORD_MAP_FIELDS.has(field)
    || (file === "worldstate/activities.json" && ACTIVITY_MAPS.has(field))
    || (file === "progression/nightwave.json" && field === "challenges")
    || (file === "rewards/bounties.json" && (field === "definitions" || field === "rewardPools"));
}
export function isSingleObject(file: string, field: string, parents: string[] = []): boolean {
  return SINGLE_OBJECT_FIELDS.has(field)
    || (file === "worldstate/activities.json" && (field === "conquests" || field === "descents"))
    || (parents.at(-1) === "reverseIndexReconciliation" && ["mods", "blueprints", "resources"].includes(field));
}

/** Recursively inline singular records; promote their collections WITHOUT expanding or joining them. */
export function compactRecord(value: unknown, file = "", parents: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((child) => compactRecord(child, file, parents));
  if (!obj(value)) return value;
  const result: Obj = {};
  const put = (key: string, child: unknown) => {
    if (Object.hasOwn(result, key)) throw new Error(`Compact field collision in ${file}: ${[...parents, key].join(".")}`);
    Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
  };
  for (const [key, child] of Object.entries(value)) {
    const path = [...parents, key];
    const collectionField = key.split(FIELD_SEPARATOR).at(-1) ?? key;
    // Map members are keys, not fields of the enclosing record (e.g. locale or refinement names).
    const next = isRecordMap(file, collectionField) && obj(child)
      ? Object.fromEntries(Object.entries(child).map(([id, row]) => [id, compactRecord(row, file, [...path, "*"])]))
      : compactRecord(child, file, path);
    if (isSingleObject(file, key, parents) && obj(next) && Object.keys(next).length) {
      for (const [subkey, item] of Object.entries(next)) put(`${key}${FIELD_SEPARATOR}${subkey}`, item);
    } else put(key, next); // Preserve null, empty objects, absent fields and every array verbatim in shape.
  }
  return result;
}

/** Apply at the END of projection: upstream enrichment still works with its native structured objects. */
export function compactProductValue(value: unknown, inputPath: string): unknown {
  const file = canonicalProductPath(inputPath);
  if (file === "reference/language-en.json" || file === "reference/language-zh.json") return value;
  if (Array.isArray(value)) return compactRecord(value, file);
  if (!obj(value)) return value;
  if (DOCUMENT_PRODUCTS.has(file)) return compactRecord(value, file);
  if (SECTION_MAP_PRODUCTS.has(file) || file === "reference/item-localizations.json") {
    return Object.fromEntries(Object.entries(value).map(([section, rows]) => [section,
      obj(rows) ? Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, compactRecord(row, file, [section, "*"])]))
        : compactRecord(rows, file, [section]),
    ]));
  }
  // Default: one keyed entity collection; never interpret an entity ID as an object field.
  return Object.fromEntries(Object.entries(value).map(([id, row]) => [id, compactRecord(row, file, ["*"])]));
}

export function compactProducts(files: DatasetFileInput[]): DatasetFileInput[] {
  return files.map((file) => {
    if (file.stage !== "cleaned") return file;
    const value = JSON.parse(String(file.content)) as unknown;
    const content = `${JSON.stringify(compactProductValue(value, file.path), null, 2)}\n`;
    return { ...file, content, source: { ...file.source,
      upstreamRevision: createHash("sha256").update(content).digest("hex"),
      transformer: "warframe-datasource-nnm/compact-products@1",
    } };
  });
}
