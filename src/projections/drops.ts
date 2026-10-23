import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";
import { canonicalIdentity, ordinaryCandidates } from "./identity.js";
import { rewardEvidence, sourceRewards, type RewardEvidenceIndex } from "./reward-evidence.js";
import { drawMechanism, percentProbability } from "./probability.js";

type JsonObject = Record<string, unknown>;
type DropRow = JsonObject & {
  category: string;
  source: string;
  item: string;
  groups: string[];
  rarity: string;
  chance: number | null;
  sourceDropChancePercent?: number;
};
type ItemReference = JsonObject & {
  name: string;
  nameZh: string;
  identityResolution: "unique" | "ambiguous" | "unresolved" | "rule" | "currency" | "category";
};
type Reward = JsonObject & { item: ItemReference };
type Group = { name: string; nameZh: string; groups: Group[]; rewards: Reward[] };
type DropContext = {
  category: string;
  source: ItemReference;
  sourceDropChancePercent?: number;
  rewards: Reward[];
  groups: Group[];
};
type ItemIndexes = {
  evidence: RewardEvidenceIndex;
  byName: Map<string, Set<string>>;
  rewardIds: Set<string>;
  byIdentity: Map<string, { name: string; nameZh: string; iconUrl?: string }>;
};

const ITEM_I18N = "catalog/i18n/items.json";
const EXCLUDED_CATEGORIES = new Set(["Relics", "Relic Drops by Source"]);
const INDEX_FAMILIES = [
  { name: "mods", forward: "Mod Drops by Source", reverse: "Mod Drops by Mod" },
  { name: "blueprints", forward: "Blueprint/Item Drops by Source", reverse: "Blueprint/Item Drops by Blueprint/Item" },
  { name: "resources", forward: "Resource Drops by Source", reverse: "Resource Drops by Resource" },
] as const;

/** Projects the official drop tables into source-owned reward groups and reconciles reverse indexes. */
export function projectDropTables(
  dropFiles: DatasetFileInput[],
  catalogFiles: DatasetFileInput[],
  languagesFiles: DatasetFileInput[],
): DatasetFileInput[] {
  const rows = dropFiles
    .filter((file) => file.stage === "cleaned" && file.path.startsWith("drop/") && file.path.endsWith(".json"))
    .flatMap((file) => readRows(file));
  const itemIndexes = buildItemIndexes(catalogFiles);
  const translations = buildTranslationIndex(languagesFiles);
  // An HTML reward label can name a pickup omitted from the item export. Reuse only
  // identities independently established by the linked source pools and agreeing across sources.
  const contextualNames = new Map<string, Set<string>>();
  for (const row of rows) {
    const reference = itemReference(row.item, itemIndexes, translations, row.category, row);
    if (reference.identityResolution !== "unique" || reference.resolutionBasis !== "linked_source_unique_reward_slot") continue;
    const key = normalize(reference.name), ids = contextualNames.get(key) ?? new Set<string>();
    ids.add(String(reference.uniqueName)); contextualNames.set(key, ids);
  }
  for (const [key, ids] of contextualNames) {
    if (ids.size !== 1 || itemIndexes.byName.has(key)) continue;
    itemIndexes.byName.set(key, ids);
    const id = [...ids][0]!;
    if (!itemIndexes.byIdentity.has(id)) itemIndexes.byIdentity.set(id, { name: rows.find((row) => normalize(row.item) === key)?.item ?? key, nameZh: translations.get(key) ?? "" });
  }
  // Match an entire independently exported pool, never one numeric chance in isolation.
  const grouped = new Map<string, DropRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.category, row.source, row.groups, row.sourceTableIndex]);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const poolNames = new Map<string, { name: string; ids: Set<string> }>();
  const equivalent = (id: string) => canonicalIdentity(id).replace(/(\/Projections\/.*?)(?:Bronze|Silver|Gold|Platinum)$/u, "$1");
  for (const group of grouped.values()) {
    const references = group.map((row) => itemReference(row.item, itemIndexes, translations, row.category, row));
    const missing = references.flatMap((ref, i) => ref.identityResolution === "unresolved" ? [i] : []);
    if (missing.length !== 1 || references.filter((ref) => ref.identityResolution === "unique").length < 3) continue;
    const target = missing[0]!, targetRow = group[target]!, ids = new Set<string>();
    for (const pool of itemIndexes.evidence.pools) {
      if (pool.length !== group.length) continue;
      const edges = group.map((row, index) => pool.flatMap((entry, slot) => {
        if (row.chance === null || entry.probability === undefined || Math.abs(row.chance / 100 - entry.probability) > 0.000001) return [];
        const ref = references[index]!;
        if (ref.identityResolution === "unique" && equivalent(String(ref.uniqueName)) !== equivalent(entry.uniqueName)) return [];
        if (ref.identityResolution === "unique" && ref.count !== undefined && ref.count !== entry.count) return [];
        return [slot];
      }));
      if (edges.some((edge) => !edge.length)) continue;
      for (const slot of edges[target]!) {
        const ordered = edges.map((options, index) => ({ options, index })).filter((entry) => entry.index !== target).sort((a, b) => a.options.length - b.options.length);
        const used = new Set([slot]);
        const assign = (offset: number): boolean => {
          if (offset === ordered.length) return true;
          for (const option of ordered[offset]!.options) {
            if (used.has(option)) continue;
            used.add(option); if (assign(offset + 1)) return true; used.delete(option);
          }
          return false;
        };
        if (assign(0)) ids.add(pool[slot]!.uniqueName);
      }
    }
    if (!ids.size) continue;
    const key = normalize(targetRow.item), known = poolNames.get(key) ?? { name: targetRow.item, ids: new Set<string>() };
    ids.forEach((id) => known.ids.add(id)); poolNames.set(key, known);
  }
  for (const [key, { name, ids }] of poolNames) {
    if (ids.size !== 1 || itemIndexes.byName.has(key)) continue;
    itemIndexes.byName.set(key, ids);
    itemIndexes.byIdentity.set([...ids][0]!, { name, nameZh: translations.get(key) ?? "" });
  }
  const reverseIndexes = new Map<DropRow, {
    status: string;
    sourceDropChancePercent?: number;
    rarity?: string;
    dropChancePercent?: number | null;
  }>();
  const reconciliation: JsonObject = {};
  const reverseOnlyRows: DropRow[] = [];

  for (const family of INDEX_FAMILIES) {
    const forwardRows = rows.filter((row) => row.category === family.forward);
    const reverseRows = rows.filter((row) => row.category === family.reverse);
    const reverseByEdge = new Map<string, DropRow[]>();
    for (const row of reverseRows) {
      const key = edgeKey(row.item, row.source);
      const candidates = reverseByEdge.get(key) ?? [];
      candidates.push(row);
      reverseByEdge.set(key, candidates);
    }

    let matched = 0;
    let chanceDisagreements = 0;
    for (const row of forwardRows) {
      const candidates = reverseByEdge.get(edgeKey(row.source, row.item));
      const reverse = candidates?.shift();
      if (!reverse) {
        reverseIndexes.set(row, { status: "forward_only" });
        continue;
      }
      matched += 1;
      const probabilityConflict = row.chance !== reverse.chance || row.rarity !== reverse.rarity;
      if (probabilityConflict) chanceDisagreements += 1;
      reverseIndexes.set(row, {
        status: probabilityConflict ? "probability_conflict" : "both_indexes",
        ...(probabilityConflict ? { rarity: reverse.rarity, dropChancePercent: reverse.chance } : {}),
        ...(reverse.sourceDropChancePercent === undefined
          ? {}
          : { sourceDropChancePercent: reverse.sourceDropChancePercent }),
      });
    }
    for (const leftover of reverseByEdge.values()) {
      for (const row of leftover) {
        const reverseOnly = {
          ...row,
          category: family.forward,
          source: row.item,
          item: row.source,
        };
        reverseOnlyRows.push(reverseOnly);
        reverseIndexes.set(reverseOnly, {
          status: "reverse_only",
          ...(row.sourceDropChancePercent === undefined ? {} : { sourceDropChancePercent: row.sourceDropChancePercent }),
        });
      }
    }
    reconciliation[family.name] = {
      forwardRows: forwardRows.length,
      reverseRows: reverseRows.length,
      matchedRows: matched,
      forwardOnlyRows: forwardRows.length - matched,
      reverseOnlyRows: reverseRows.length - matched,
      probabilityDisagreements: chanceDisagreements,
      sourceDropChanceDisagreements: forwardRows.filter((row) => {
        const reverse = reverseIndexes.get(row);
        return reverse?.status !== undefined && reverse.sourceDropChancePercent !== undefined
          && row.sourceDropChancePercent !== reverse.sourceDropChancePercent;
      }).length,
    };
  }

  const canonicalRows = rows.filter((row) => !EXCLUDED_CATEGORIES.has(row.category)
    && !INDEX_FAMILIES.some((family) => row.category === family.reverse));
  for (const row of reverseOnlyRows) canonicalRows.push(row);

  const contexts = buildContexts(canonicalRows, itemIndexes, translations, reverseIndexes);
  const quality = summarizeQuality(contexts, reconciliation);
  const mapFile = catalogFiles.find((file) => file.path === "catalog/world/map.json");
  const map = mapFile ? asObject(JSON.parse(asText(mapFile.content)), mapFile.path) : {};
  const systems = Array.isArray(map.systems) ? map.systems : [];
  const regionResources = systems.map((raw) => {
    const system = asObject(raw, "system");
    return { systemIndex: system.systemIndex, name: system.name, nameZh: system.nameZh, resources: system.resources ?? [] };
  });
  const value = { regionResources, contexts, quality };
  const rawFile = dropFiles.find((file) => file.stage === "raw" && file.path === "droptables/droptables.html");
  if (!rawFile) throw new Error("Official drop-table raw input is missing");
  const catalogFile = catalogFiles.find((file) => file.path === ITEM_I18N);
  if (!catalogFile) throw new Error(`Drop projection input is missing: ${ITEM_I18N}`);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const path = "drop/tables.json";
  return [{
    stage: "cleaned",
    path,
    content,
    recordCount: contexts.reduce((count, context) => count + countRewards(context), 0),
    source: {
      ...rawFile.source,
      dataset: path,
      upstreamRevision: createHash("sha256").update(content).digest("hex"),
      transformer: "warframe-datasource-nnm/drop-context-projection@1",
      derivedFrom: [rawFile.path, catalogFile.path],
    },
  }];
}

function buildContexts(
  rows: DropRow[],
  indexes: ItemIndexes,
  translations: Map<string, string>,
  reverseIndexes: Map<DropRow, {
    status: string;
    sourceDropChancePercent?: number;
    rarity?: string;
    dropChancePercent?: number | null;
  }>,
): DropContext[] {
  const contexts = new Map<string, DropContext>();
  for (const row of rows) {
    const key = JSON.stringify([row.category, row.source, row.sourceDropChancePercent ?? null, row.sourceTableIndex ?? null]);
    let context = contexts.get(key);
    if (!context) {
      context = {
        category: row.category,
        ...(row.sourceTableIndex === undefined ? {} : { poolId: `${row.category}:${row.sourceTableIndex}` }),
        source: itemReference(row.source, indexes, translations),
        ...(row.sourceDropChancePercent === undefined ? {} : { sourceDropChancePercent: row.sourceDropChancePercent }),
        ...drawMechanism((row.sourceDropChancePercent ?? 100) / 100),
        rewards: [],
        groups: [],
      };
      contexts.set(key, context);
    }
    const reward = rewardFor(row, indexes, translations, reverseIndexes.get(row));
    if (row.groups.length === 0) {
      context.rewards.push(reward);
      continue;
    }
    let current = context.groups;
    let group: Group | undefined;
    for (const name of row.groups) {
      group = current.find((candidate) => candidate.name === name);
      if (!group) {
        group = { name, nameZh: translations.get(normalize(name)) ?? "", groups: [], rewards: [] };
        current.push(group);
      }
      current = group.groups;
    }
    group?.rewards.push(reward);
  }
  return [...contexts.values()].sort((left, right) => compareText(left.category, right.category)
    || compareText(left.source.name, right.source.name)
    || compareNumber(left.sourceDropChancePercent, right.sourceDropChancePercent));
}

function rewardFor(
  row: DropRow,
  indexes: ItemIndexes,
  translations: Map<string, string>,
  reverseIndex: { status: string; sourceDropChancePercent?: number; rarity?: string; dropChancePercent?: number | null } | undefined,
): Reward {
  return {
    item: itemReference(row.item, indexes, translations, row.category, row),
    rarity: row.rarity,
    probability: percentProbability(row.chance),
    dropChancePercent: row.chance,
    chanceResolution: row.chance === null ? "unparsed" : /Under Review/iu.test(row.rarity) ? "under_review" : "parsed",
    ...(row.sourceChanceText === undefined ? {} : { sourceChanceText: row.sourceChanceText }),
    ...(row.sourceDropChancePercent === undefined ? {} : { sourceDropChancePercent: row.sourceDropChancePercent }),
    ...(reverseIndex ? {
      reverseIndex: {
        status: reverseIndex.status,
        ...(reverseIndex.rarity === undefined ? {} : { rarity: reverseIndex.rarity }),
        ...(reverseIndex.dropChancePercent === undefined ? {} : { dropChancePercent: reverseIndex.dropChancePercent }),
        ...(reverseIndex.sourceDropChancePercent === undefined
          ? {}
          : { sourceDropChancePercent: reverseIndex.sourceDropChancePercent }),
      },
    } : {}),
  };
}

function itemReference(
  value: string,
  indexes: ItemIndexes,
  translations: Map<string, string>,
  category = "",
  row?: DropRow,
): ItemReference {
  const countMatch = /^([\d,]+)\s*[xX]\s+(.+)$/u.exec(value.trim());
  let count = countMatch?.[1] ? Number(countMatch[1].replaceAll(",", "")) : undefined;
  let name = countMatch?.[2]?.trim() ?? value;
  const currency = /^([\d,]+)\s+(Endo|Credits?(?: Cache)?)$/iu.exec(name);
  if (currency?.[1] && currency[2]) {
    const quantity = Number(currency[1].replaceAll(",", "")) * (count ?? 1);
    const endo = currency[2].toLowerCase() === "endo";
    return { kind: "currency", currency: endo ? "endo" : "credits", name: endo ? "Endo" : "Credits",
      nameZh: endo ? "内融核心" : "现金", count: quantity, quantity, displayName: value, identityResolution: "currency" };
  }
  if (name === "Region Resource") return { kind: "region_resource", ruleKey: "mission_region_resources", name, nameZh: "区域资源",
    identityResolution: "rule", regionSelection: "mission_context", resourceCandidatesRef: "regionResources", ...(count === undefined ? {} : { count }) };
  const refinement = /^(.*?)\s+\((Intact|Exceptional|Flawless|Radiant)\)$/u.exec(name);
  const refinementSuffix: Record<string, string> = { Intact: "Bronze", Exceptional: "Silver", Flawless: "Gold", Radiant: "Platinum" };
  let namedCandidates = [...(indexes.byName.get(normalize(refinement?.[1] ?? name)) ?? [])].sort(compareText);
  if (refinement) namedCandidates = namedCandidates.filter((id) => id.includes("/Projections/") && id.endsWith(refinementSuffix[refinement[2]!]!));
  // Drop rewards are inventory entities. A same-name enemy, challenge or bounty is not a variant.
  // Sources still use the complete index, so enemy identities remain resolvable.
  if (category && namedCandidates.length > 1) {
    const inventory = namedCandidates.filter((id) => indexes.rewardIds.has(id));
    if (inventory.length) namedCandidates = inventory;
  }
  if (category === "Mod Drops by Source") {
    const mods = namedCandidates.filter((id) => id.includes("/Upgrades/Mods/"));
    if (mods.length) namedCandidates = mods;
  }
  let candidates = refinement ? namedCandidates : ordinaryCandidates(namedCandidates, name);
  let resolutionBasis: string | undefined;
  if (row) {
    const linked = sourceRewards(indexes.evidence, row.source, category);
    const linkedIds = new Set(linked.map((entry) => entry.uniqueName));
    const contextual = candidates.filter((id) => linkedIds.has(canonicalIdentity(id)));
    if (contextual.length) { candidates = contextual; resolutionBasis = "linked_source_reward_definition"; }
    // No label exists for some gameplay pickups. Resolve only a unique slot in an explicitly linked pool.
    if (!candidates.length && row.chance !== null) {
      const slots = linked.filter((entry) => entry.probability !== undefined
        && Math.abs(entry.probability - row.chance! / 100) < 0.000001 && entry.count === (count ?? 1));
      const ids = [...new Set(slots.map((entry) => entry.uniqueName))];
      if (ids.length === 1) { candidates = ids; resolutionBasis = "linked_source_unique_reward_slot"; }
    }
    const family = candidates.length > 1 && (candidates.every((id) => id.includes("/Items/Fish/"))
      || candidates.every((id) => id.includes("/Mods/Randomized/")));
    if (!contextual.length && !family && candidates.length > 1) {
      const awarded = candidates.filter((id) => indexes.evidence.awarded.has(canonicalIdentity(id)));
      if (awarded.length === 1) { candidates = awarded; resolutionBasis = "official_awarded_identity"; }
    }
    if (family && candidates.length > 1) return {
      kind: "reward_category", name, nameZh: translations.get(normalize(name)) || indexes.byIdentity.get(candidates[0]!)?.nameZh || "",
      identityResolution: "category", selection: "unspecified_by_official_table", probabilityScope: "category",
      candidates: candidates.map((id) => ({ uniqueName: id, ...(indexes.byIdentity.get(id) ?? {}) })),
      ...(count === undefined ? {} : { count }),
    };
  }
  const uniqueName = candidates.length === 1 ? candidates[0] : undefined;
  const details = uniqueName ? indexes.byIdentity.get(uniqueName) : undefined;
  return {
    ...(uniqueName ? { uniqueName } : {}),
    ...(uniqueName?.includes("/Lore/Fragments/") ? { kind: "reward_selector", contentResolution: "individual_fragments_not_exported" } : {}),
    ...(resolutionBasis ? { resolutionBasis } : {}),
    name,
    ...(refinement ? { refinement: refinement[2] } : {}),
    nameZh: details?.nameZh || translations.get(normalize(name)) || "",
    ...(details?.iconUrl ? { iconUrl: details.iconUrl } : {}),
    ...(count === undefined ? {} : { count }),
    identityResolution: candidates.length === 1 ? "unique" : candidates.length > 1 ? "ambiguous" : "unresolved",
    ...(candidates.length > 1 ? { candidateUniqueNames: candidates } : {}),
  };
}

function buildItemIndexes(catalogFiles: DatasetFileInput[]): ItemIndexes {
  const file = catalogFiles.find((candidate) => candidate.path === ITEM_I18N);
  if (!file) throw new Error(`Drop projection input is missing: ${ITEM_I18N}`);
  const catalog = asObject(JSON.parse(asText(file.content)) as unknown, ITEM_I18N);
  const indexes = new Map<string, Set<string>>();
  const details = new Map<string, { name: string; nameZh: string; iconUrl?: string }>();
  const rewardIds = new Set<string>();
  for (const candidate of catalogFiles) {
    if (candidate.stage !== "cleaned" || !/^(?:catalog\/(?:equipment|upgrades|craft)\/|(?:equipment|upgrades|crafting|resources|cosmetics|quests|companions|commerce)\/)/u.test(candidate.path)) continue;
    const root = JSON.parse(asText(candidate.content)) as unknown;
    const records = Array.isArray(root) ? root.map((entry) => ["", entry] as const) : Object.entries(asObject(root, candidate.path));
    for (const [key, raw] of records) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as JsonObject;
      const id = text(record, "uniqueName") ?? key;
      if (id.startsWith("/Lotus/")) rewardIds.add(id);
      if (Array.isArray(record.identityAliases)) for (const alias of record.identityAliases) if (typeof alias === "string") rewardIds.add(alias);
    }
  }
  for (const [uniqueName, raw] of Object.entries(catalog)) {
    const entry = asObject(raw, `${ITEM_I18N}/${uniqueName}`);
    const en = asObject(entry.en, `${uniqueName}/en`);
    const zh = asObject(entry.zh, `${uniqueName}/zh`);
    const name = text(en, "name");
    if (!name) continue;
    const key = normalize(name);
    const candidates = indexes.get(key) ?? new Set<string>();
    candidates.add(uniqueName);
    indexes.set(key, candidates);
    const iconUrl = text(entry, "iconUrl");
    details.set(uniqueName, { name, nameZh: text(zh, "name") ?? "", ...(iconUrl ? { iconUrl } : {}) });
  }
  for (const file of catalogFiles) {
    if (file.stage !== "cleaned" || !file.path.startsWith("plus/")) continue;
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      const record = value as JsonObject;
      for (const [id, raw] of Object.entries(record)) {
        if (!id.startsWith("/Lotus/") || !raw || typeof raw !== "object" || Array.isArray(raw)) { visit(raw); continue; }
        const entity = raw as JsonObject;
        const name = text(entity, "nameEn") ?? text(entity, "name") ?? "";
        const nameZh = text(entity, "nameZh") ?? "";
        if (name && !name.startsWith("/")) {
          const candidates = indexes.get(normalize(name)) ?? new Set<string>();
          candidates.add(id);
          indexes.set(normalize(name), candidates);
          if (!details.has(id)) details.set(id, { name, nameZh, ...(typeof entity.iconUrl === "string" ? { iconUrl: entity.iconUrl } : {}) });
        }
        visit(entity);
      }
    };
    visit(JSON.parse(asText(file.content)) as unknown);
  }
  // Refinement names refer to one relic parent in ordinary drop tables.
  for (const [id, info] of [...details]) {
    const parent = id.replace(/(?:Bronze|Silver|Gold|Platinum)$/u, "");
    if (parent !== id && id.includes("/Projections/") && !details.has(parent)) details.set(parent, info);
  }
  const recipeFile = catalogFiles.find((candidate) => candidate.path === "catalog/craft/recipes.json");
  if (recipeFile) {
    const recipes = asObject(JSON.parse(asText(recipeFile.content)), recipeFile.path);
    const aliasIds = new Map<string, string>();
    for (const [id, recipe] of Object.entries(recipes)) {
      const aliases = asObject(recipe, id).identityAliases;
      if (Array.isArray(aliases)) for (const alias of aliases) if (typeof alias === "string") aliasIds.set(alias, id);
    }
    for (const [name, rawIds] of indexes) {
      const ids = new Set([...rawIds].map((id) => aliasIds.get(id) ?? id));
      indexes.set(name, ids);
      if (ids.size < 2 || ![...ids].every((id) => recipes[id])) continue;
      const signatures = [...ids].map((id) => recipeSignature(asObject(recipes[id], id)));
      if (signatures.every((signature) => signature === signatures[0])) indexes.set(name, new Set([[...ids].sort()[0] as string]));
    }
  }
  return { byName: indexes, byIdentity: details, rewardIds, evidence: rewardEvidence(catalogFiles) };
}

function buildTranslationIndex(languagesFiles: DatasetFileInput[]): Map<string, string> {
  const enFile = languagesFiles.find((file) => file.path === "languages/en.json");
  const zhFile = languagesFiles.find((file) => file.path === "languages/zh.json");
  if (!enFile || !zhFile) return new Map();
  const en = asObject(JSON.parse(asText(enFile.content)) as unknown, enFile.path);
  const zh = asObject(JSON.parse(asText(zhFile.content)) as unknown, zhFile.path);
  const candidates = new Map<string, Set<string>>();
  for (const [key, english] of Object.entries(en)) {
    const chinese = text(zh, key);
    if (typeof english !== "string" || !english || !chinese) continue;
    const normalized = normalize(english);
    const values = candidates.get(normalized) ?? new Set<string>();
    values.add(chinese);
    candidates.set(normalized, values);
  }
  return new Map([...candidates].flatMap(([key, values]) => values.size === 1 ? [[key, [...values][0] as string]] : []));
}

function summarizeQuality(contexts: DropContext[], reconciliation: JsonObject): JsonObject {
  let rewards = 0;
  let uniqueItems = 0;
  let ambiguousItems = 0;
  let unresolvedItems = 0;
  let categories = 0;
  let rules = 0;
  let currencies = 0;
  const visit = (reward: Reward) => {
    rewards += 1;
    if (reward.item.identityResolution === "unique") uniqueItems += 1;
    else if (reward.item.identityResolution === "ambiguous") ambiguousItems += 1;
    else if (reward.item.identityResolution === "category") categories += 1;
    else if (reward.item.identityResolution === "rule") rules += 1;
    else if (reward.item.identityResolution === "currency") currencies += 1;
    else unresolvedItems += 1;
  };
  for (const context of contexts) {
    context.rewards.forEach(visit);
    const visitGroups = (groups: Group[]) => groups.forEach((group) => {
      group.rewards.forEach(visit);
      visitGroups(group.groups);
    });
    visitGroups(context.groups);
  }
  return {
    sourceContextCount: contexts.length,
    rewardCount: rewards,
    itemIdentity: { unique: uniqueItems, ambiguous: ambiguousItems, unresolved: unresolvedItems, categories, rules, currencies },
    reverseIndexReconciliation: reconciliation,
  };
}

function countRewards(context: DropContext): number {
  const countGroups = (groups: Group[]): number => groups.reduce((total, group) =>
    total + group.rewards.length + countGroups(group.groups), 0);
  return context.rewards.length + countGroups(context.groups);
}

function readRows(file: DatasetFileInput): DropRow[] {
  const value = JSON.parse(asText(file.content)) as unknown;
  if (!Array.isArray(value)) throw new Error(`Expected array in ${file.path}`);
  return value.map((entry, index) => {
    const row = asObject(entry, `${file.path}[${index}]`);
    if (typeof row.category !== "string" || typeof row.source !== "string" || typeof row.item !== "string"
      || !Array.isArray(row.groups) || typeof row.rarity !== "string" || (row.chance !== null && typeof row.chance !== "number")) {
      throw new Error(`Invalid official drop row in ${file.path}[${index}]`);
    }
    return row as DropRow;
  });
}

function edgeKey(source: string, item: string): string {
  return JSON.stringify([normalize(source), normalize(item)]);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/<[A-Z][A-Z0-9_]*>/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number | undefined, right: number | undefined): number {
  return (left ?? -1) - (right ?? -1);
}

function asObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

function text(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function asText(content: Buffer | string): string {
  return Buffer.isBuffer(content) ? content.toString("utf8") : content;
}

function recipeSignature(recipe: JsonObject): string {
  const { uniqueName: _id, recordKey: _key, name: _name, nameZh: _zh, ...behavior } = recipe;
  return JSON.stringify(stableValue(behavior));
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b)).map(([k, v]) => [k, stableValue(v)]));
}
