import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";
import { percentProbability, drawMechanism } from "./probability.js";

type JsonObject = Record<string, unknown>;
type ItemReference = {
  uniqueName: string;
  name: string;
  nameZh: string;
  iconUrl?: string;
  marketSlug?: string;
  itemCount?: number;
};
type RelicState = JsonObject & {
  rewards: JsonObject[];
  unresolvedDropRewards: JsonObject[];
};
type Relic = JsonObject & {
  states: Record<string, RelicState>;
  locations: JsonObject[];
  marketListings: JsonObject[];
};

const EN_RELICS = "public-export/en/ExportRelicArcane_en.json";
const ZH_RELICS = "public-export/zh/ExportRelicArcane_zh.json";
const I18N_ITEMS = "catalog/i18n/items.json";
const DROP_RELICS = "drop/relics.json";
const DROP_MISSIONS = "drop/missions.json";
const DROP_RELIC_SOURCES = "drop/relic-drops-by-source.json";
const MARKET_ITEMS = "market/items.json";
const LANG_EN = "languages/en.json";
const LANG_ZH = "languages/zh.json";

const REFINEMENTS: Record<string, string> = {
  Bronze: "Intact",
  Silver: "Exceptional",
  Gold: "Flawless",
  Platinum: "Radiant",
};

/** Combines official refinement records and all parsed relic-table relationships in one entity file. */
export function projectRelics(
  publicExportFiles: DatasetFileInput[],
  catalogFiles: DatasetFileInput[],
  dropFiles: DatasetFileInput[],
  marketFiles: DatasetFileInput[],
  languagesFiles: DatasetFileInput[],
  plusFiles: DatasetFileInput[] = [],
): DatasetFileInput[] {
  const enRecords = readExportArray(publicExportFiles, EN_RELICS, "ExportRelicArcane")
    .filter((record) => text(record, "uniqueName")?.includes("/Projections/") === true);
  const zhRecords = new Map(readExportArray(publicExportFiles, ZH_RELICS, "ExportRelicArcane")
    .filter((record) => text(record, "uniqueName")?.includes("/Projections/") === true)
    .map((record) => [text(record, "uniqueName") as string, record]));
  const i18n = readObject(catalogFiles, I18N_ITEMS);
  const marketItems = readArray(marketFiles, MARKET_ITEMS);
  const dropRelics = readArray(dropFiles, DROP_RELICS);
  const dropMissions = readArray(dropFiles, DROP_MISSIONS);
  const dropRelicSources = readArray(dropFiles, DROP_RELIC_SOURCES);
  const languagesEn = readObject(languagesFiles, LANG_EN);
  const languagesZh = readObject(languagesFiles, LANG_ZH);
  const { itemByIdentity, itemIdsByName } = buildItemIndexes(i18n, marketItems);
  const zhByEnglishName = buildEnglishToChinese(languagesEn, languagesZh);

  const relicsById = new Map<string, Relic>();
  const relicIdsByName = new Map<string, string[]>();
  for (const record of enRecords) {
    const uniqueName = requiredText(record, "uniqueName", EN_RELICS);
    const displayName = requiredText(record, "name", EN_RELICS);
    const suffix = /([A-Z][a-z]+)$/u.exec(uniqueName)?.[1] ?? "";
    const refinement = REFINEMENTS[suffix] ?? "Default";
    const relicId = REFINEMENTS[suffix] ? uniqueName.slice(0, -suffix.length) : uniqueName;
    let relic = relicsById.get(relicId);
    if (!relic) {
      relic = {
        uniqueName: relicId,
        recordKey: relicId,
        name: displayName,
        nameZh: "",
        tier: relicTier(uniqueName),
        relicCode: relicCode(displayName),
        states: {},
        locations: [],
        marketListings: [],
      };
      relicsById.set(relicId, relic);
      const nameKey = normalizeName(displayName);
      relicIdsByName.set(nameKey, [...(relicIdsByName.get(nameKey) ?? []), relicId]);
    } else if (relic.name !== displayName) {
      throw new Error(`Conflicting relic names for stable identity ${relicId}`);
    }

    const localized = zhRecords.get(uniqueName);
    if (localized && text(localized, "name")) relic.nameZh = text(localized, "name") as string;
    if (relic.states[refinement]) throw new Error(`Duplicate relic refinement ${relicId}/${refinement}`);
    const rawRewards = record.relicRewards;
    if (!Array.isArray(rawRewards)) throw new Error(`${uniqueName}: relicRewards must be an array`);
    const iconUrl = text(optionalObject(i18n[uniqueName]), "iconUrl");
    const rewards = rawRewards.map((rawReward, index) => {
      const reward = asObject(rawReward, `${uniqueName}: relicRewards[${index}]`);
      const rewardName = requiredText(reward, "rewardName", uniqueName);
      return {
        ...reward,
        item: itemReferenceForIdentity(rewardName, itemByIdentity),
        dropTableEntries: [],
      } as JsonObject;
    });
    const { relicRewards: _rawRewards, ...officialFields } = record;
    relic.states[refinement] = {
      ...officialFields,
      refinement,
      uniqueName,
      name: displayName,
      nameZh: text(localized ?? {}, "name") ?? "",
      ...(iconUrl ? { iconUrl } : {}),
      rewards,
      unresolvedDropRewards: [],
    };
  }

  const plusRelics = plusFiles.find((file) => file.stage === "raw" && file.path === "plus/ExportRelics.json");
  if (plusRelics) {
    const supplemental = readObject(plusFiles, plusRelics.path);
    for (const [uniqueName, raw] of Object.entries(supplemental)) {
      const relicId = uniqueName.replace(/(?:Bronze|Silver|Gold|Platinum)$/u, "");
      const refinement = REFINEMENTS[uniqueName.slice(relicId.length)] ?? "Default";
      const state = relicsById.get(relicId)?.states[refinement];
      if (state) Object.assign(state, { ...optionalObject(raw), ...state });
    }
  }

  const rewardIndexes = buildRewardIndexes(relicsById);
  const inferredSources = new Map<string, string[]>();
  const rowsBySource = new Map<string, JsonObject[]>();
  for (const row of dropRelics) {
    const source = requiredText(row, "source", DROP_RELICS);
    const rows = rowsBySource.get(source) ?? [];
    rows.push(row);
    rowsBySource.set(source, rows);
  }
  // Missing-number groups require a complete identity/count/rate match to an existing named state.
  const signature = (rows: JsonObject[]) => rows.map((row) => {
    const item = resolveItemByName(requiredText(row, "item", DROP_RELICS), row, itemIdsByName, itemByIdentity, zhByEnglishName);
    return item.uniqueName ? JSON.stringify([canonicalIdentity(item.uniqueName), item.itemCount ?? 1, row.chance]) : "";
  }).sort().join("\n");
  for (const [source, rows] of rowsBySource) {
    const parsed = parseRelicSource(source);
    if (!parsed || relicIdsByName.has(normalizeName(parsed.name))) continue;
    const series = parsed.name.replace(/\s+Relic$/iu, "");
    if (!/^(Lith|Meso|Neo|Axi|Requiem)$/u.test(series) || rows.some((row) => !resolveItemByName(String(row.item), row, itemIdsByName, itemByIdentity, zhByEnglishName).uniqueName)) continue;
    const matches = new Set<string>();
    for (const [namedSource, namedRows] of rowsBySource) {
      const named = parseRelicSource(namedSource);
      if (!named || named.refinement !== parsed.refinement || !named.name.startsWith(`${series} `) || rows.length !== namedRows.length || signature(rows) !== signature(namedRows)) continue;
      for (const id of relicIdsByName.get(normalizeName(named.name)) ?? []) {
        const state = relicsById.get(id)?.states[parsed.refinement];
        if (!state || state.rewards.length !== rows.length) continue;
        const expected = state.rewards.map((reward) => JSON.stringify([canonicalIdentity(String(reward.rewardName)), reward.itemCount ?? 1])).sort();
        const observed = rows.map((row) => {
          const item = resolveItemByName(String(row.item), row, itemIdsByName, itemByIdentity, zhByEnglishName);
          return JSON.stringify([canonicalIdentity(item.uniqueName), item.itemCount ?? 1]);
        }).sort();
        if (JSON.stringify(expected) === JSON.stringify(observed)) matches.add(id);
      }
    }
    if (matches.size === 1) inferredSources.set(source, [...matches]);
  }
  let deduplicatedRows = 0;
  const unresolvedDropRows: JsonObject[] = [];
  let matchedDropRows = 0;
  for (const entry of dropRelics) {
    const parsed = parseRelicSource(requiredText(entry, "source", DROP_RELICS));
    if (!parsed) throw new Error(`Unrecognized relic drop source: ${text(entry, "source") ?? ""}`);
    const relicIds = relicIdsByName.get(normalizeName(parsed.name)) ?? inferredSources.get(String(entry.source)) ?? [];
    const itemName = requiredText(entry, "item", DROP_RELICS);
    const resolvedItem = resolveItemByName(itemName, entry, itemIdsByName, itemByIdentity, zhByEnglishName);
    const refinement = resolveRefinement(relicIds, parsed.refinement, relicsById);
    const candidateRelics = resolveRelicCandidates(relicIds, refinement, resolvedItem, rewardIndexes);
    const dropRecord = dropTableRecord(entry, resolvedItem);
    let attached = false;
    for (const relicId of candidateRelics) {
      const state = relicsById.get(relicId)?.states[refinement];
      if (!state) continue;
      if (resolvedItem.uniqueName) {
        const allIndexes = rewardIndexes.get(relicId)?.get(refinement)?.get(canonicalIdentity(resolvedItem.uniqueName)) ?? [];
        const indexes = resolvedItem.itemCount === undefined
          ? allIndexes
          : allIndexes.filter((index) => state.rewards[index]?.itemCount === resolvedItem.itemCount);
        const rarity = normalizeName(text(dropRecord, "rarity") ?? "");
        const rarityMatches = indexes.filter((index) =>
          normalizeName(text(state.rewards[index] ?? {}, "rarity") ?? "") === rarity,
        );
        const index = rarityMatches.length === 1 ? rarityMatches[0]
          : indexes.length === 1 ? indexes[0] : undefined;
        if (index !== undefined) {
          const reward = state.rewards[index];
          if (!reward) throw new Error(`Missing indexed relic reward ${relicId}/${refinement}/${index}`);
          const entries = reward.dropTableEntries as JsonObject[];
          if (entries.some((previous) => {
            const a = optionalObject(previous.item), b = optionalObject(dropRecord.item);
            return canonicalIdentity(String(a.uniqueName)) === canonicalIdentity(String(b.uniqueName))
              && (a.itemCount ?? 1) === (b.itemCount ?? 1) && previous.dropChancePercent === dropRecord.dropChancePercent;
          })) deduplicatedRows += 1;
          else entries.push(dropRecord);
          attached = true;
        }
      }
      if (!attached) state.unresolvedDropRewards.push({ ...dropRecord, resolution: resolvedItem.resolution });
    }
    if (attached) {
      matchedDropRows += 1;
    } else {
      unresolvedDropRows.push({
        ...dropRecord,
        sourceRelicName: parsed.name,
        refinement: parsed.refinement,
        candidateRelicIds: candidateRelics,
        resolution: candidateRelics.length === 0 ? "relic_or_item_identity_unresolved" : resolvedItem.resolution,
      });
    }
  }

  const unresolvedLocationRows: JsonObject[] = [];
  for (const entry of dropMissions) {
    const name = text(entry, "item");
    if (!name?.endsWith(" Relic")) continue;
    const relicIds = relicIdsByName.get(normalizeName(name)) ?? [];
    const location = {
      category: text(entry, "category") ?? "",
      source: text(entry, "source") ?? "",
      groups: Array.isArray(entry.groups) ? entry.groups : [],
      rarity: text(entry, "rarity") ?? "",
      probability: percentProbability(number(entry, "chance")),
      dropChancePercent: number(entry, "chance") ?? null,
      chanceResolution: number(entry, "chance") === undefined ? "unparsed" : /Under Review/iu.test(String(entry.rarity)) ? "under_review" : "parsed",
      ...(entry.sourceChanceText === undefined ? {} : { sourceChanceText: entry.sourceChanceText }),
    };
    if (relicIds.length === 0) {
      unresolvedLocationRows.push({ ...location, relicName: name });
      continue;
    }
    for (const relicId of relicIds) relicsById.get(relicId)?.locations.push(location);
  }

  const relicSourceRows = dropRelicSources.filter((entry) => text(entry, "category") === "Relic Drops by Source");
  for (const entry of relicSourceRows) {
    const name = text(entry, "item");
    if (!name?.endsWith(" Relic")) continue;
    const relicIds = relicIdsByName.get(normalizeName(name)) ?? [];
    const source = text(entry, "source") ?? "";
    const location = {
      category: text(entry, "category") ?? "",
      source,
      sourceZh: zhByEnglishName.get(normalizeName(source)) ?? "",
      groups: Array.isArray(entry.groups) ? entry.groups : [],
      rarity: text(entry, "rarity") ?? "",
      probability: percentProbability(number(entry, "chance")),
      dropChancePercent: number(entry, "chance") ?? null,
      chanceResolution: number(entry, "chance") === undefined ? "unparsed" : /Under Review/iu.test(String(entry.rarity)) ? "under_review" : "parsed",
      ...(entry.sourceChanceText === undefined ? {} : { sourceChanceText: entry.sourceChanceText }),
      ...drawMechanism((number(entry, "sourceDropChancePercent") ?? 100) / 100),
      ...(number(entry, "sourceDropChancePercent") === undefined
        ? {}
        : { sourceDropChancePercent: number(entry, "sourceDropChancePercent") }),
    };
    if (relicIds.length === 0) {
      unresolvedLocationRows.push({ ...location, relicName: name });
      continue;
    }
    for (const relicId of relicIds) relicsById.get(relicId)?.locations.push(location);
  }

  for (const relic of relicsById.values()) {
    relic.marketListings = findMarketListings(String(relic.uniqueName), relic.states, marketItems);
    const states = Object.values(relic.states);
    for (const state of states) {
      for (const reward of state.rewards) {
        const dropEntries = reward.dropTableEntries as JsonObject[];
        if (dropEntries.length === 1) {
          reward.dropChancePercent = dropEntries[0]?.dropChancePercent;
          reward.probability = percentProbability(number(dropEntries[0] ?? {}, "dropChancePercent"));
          reward.dropRarity = dropEntries[0]?.rarity;
        }
      }
    }
  }

  if (matchedDropRows + unresolvedDropRows.length !== dropRelics.length) {
    throw new Error("Relic drop relationship reconciliation failed");
  }

  const relics = [...relicsById.values()].sort((left, right) =>
    String(left.uniqueName).localeCompare(String(right.uniqueName)),
  );
  const value = {
    relics,
    unresolvedDropRows,
    unresolvedLocationRows,
    quality: {
      relicCount: relics.length,
      officialStateCount: enRecords.length,
      dropTableRows: dropRelics.length,
      matchedDropRows,
      inferredSourceGroups: inferredSources.size,
      deduplicatedRows,
      unresolvedDropRows: unresolvedDropRows.length,
      missionLocationRows: dropMissions.filter((entry) => text(entry, "item")?.endsWith(" Relic")).length,
      relicSourceRows: relicSourceRows.length,
      unresolvedLocationRows: unresolvedLocationRows.length,
    },
  };
  const paths = [EN_RELICS, ZH_RELICS, I18N_ITEMS, "droptables/droptables.html", MARKET_ITEMS, LANG_EN, LANG_ZH];
  if (plusRelics) paths.push(plusRelics.path);
  const sourceFiles = paths.map((path) => findFile(path, [
    ...publicExportFiles, ...catalogFiles, ...dropFiles, ...marketFiles, ...languagesFiles, ...plusFiles,
  ]));
  const capturedAt = sourceFiles[0]?.source.capturedAt ?? "";
  return [{
    stage: "cleaned",
    path: "catalog/loot/relics.json",
    content: `${JSON.stringify(value, null, 2)}\n`,
    recordCount: relics.length,
    source: {
      project: "warframe-datasource-nnm",
      dataset: "catalog/loot/relics.json",
      url: "https://www.warframe.com/droptables",
      capturedAt,
      upstreamRevision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      transformer: "warframe-datasource-nnm/relic-projection@2",
      derivedFrom: paths,
    },
  }];
}

function buildItemIndexes(
  translations: JsonObject,
  marketItems: JsonObject[],
): { itemByIdentity: Map<string, ItemReference>; itemIdsByName: Map<string, Set<string>> } {
  const itemByIdentity = new Map<string, ItemReference>();
  const itemIdsByName = new Map<string, Set<string>>();
  for (const [uniqueName, value] of Object.entries(translations)) {
    const translation = asObject(value, `item translation ${uniqueName}`);
    const en = optionalObject(translation.en);
    const zh = optionalObject(translation.zh);
    const iconUrl = text(translation, "iconUrl");
    const item: ItemReference = {
      uniqueName,
      name: text(en, "name") ?? "",
      nameZh: text(zh, "name") ?? "",
      ...(iconUrl ? { iconUrl } : {}),
    };
    mergeItem(itemByIdentity, item);
    addName(itemIdsByName, item.name, uniqueName);
  }
  for (const marketItem of marketItems) {
    const gameRef = text(marketItem, "gameRef");
    if (!gameRef) continue;
    const marketI18n = optionalObject(marketItem.i18n);
    const en = optionalObject(marketI18n.en);
    const zh = optionalObject(marketI18n.zh);
    const icon = text(marketItem, "icon") ?? text(en, "icon");
    const marketSlug = text(marketItem, "slug");
    const item: ItemReference = {
      uniqueName: gameRef,
      name: text(en, "name") ?? text(marketItem, "name") ?? "",
      nameZh: text(zh, "name") ?? "",
      ...(icon ? { iconUrl: marketAssetUrl(icon) } : {}),
      ...(marketSlug ? { marketSlug } : {}),
    };
    mergeItem(itemByIdentity, item);
    addName(itemIdsByName, item.name, gameRef);
  }
  return { itemByIdentity, itemIdsByName };
}

function mergeItem(target: Map<string, ItemReference>, item: ItemReference): void {
  const key = canonicalIdentity(item.uniqueName);
  const previous = target.get(key);
  target.set(key, {
    uniqueName: previous?.uniqueName ?? item.uniqueName,
    name: previous?.name || item.name,
    nameZh: previous?.nameZh || item.nameZh,
    ...(previous?.iconUrl || item.iconUrl ? { iconUrl: previous?.iconUrl ?? item.iconUrl } : {}),
    ...(previous?.marketSlug || item.marketSlug ? { marketSlug: previous?.marketSlug ?? item.marketSlug } : {}),
  });
}

function addName(index: Map<string, Set<string>>, name: string, uniqueName: string): void {
  if (!name) return;
  const key = normalizeName(name);
  const values = index.get(key) ?? new Set<string>();
  values.add(canonicalIdentity(uniqueName));
  index.set(key, values);
}

function itemReferenceForIdentity(
  uniqueName: string,
  itemByIdentity: Map<string, ItemReference>,
): JsonObject {
  const item = itemByIdentity.get(canonicalIdentity(uniqueName));
  return {
    uniqueName,
    name: item?.name ?? "",
    nameZh: item?.nameZh ?? "",
    ...(item?.iconUrl ? { iconUrl: item.iconUrl } : {}),
    ...(item?.marketSlug ? { marketSlug: item.marketSlug } : {}),
    resolution: item?.name || item?.nameZh ? "localized" : "stable_identity_only",
  };
}

function resolveItemByName(
  name: string,
  entry: JsonObject,
  itemIdsByName: Map<string, Set<string>>,
  itemByIdentity: Map<string, ItemReference>,
  zhByEnglishName: Map<string, string>,
): ItemReference & { resolution: string } {
  const quantity = /^(\d+)X\s+(.+)$/iu.exec(name);
  const resolvedName = quantity?.[2] ?? name;
  const itemCount = quantity?.[1] ? Number(quantity[1]) : undefined;
  const ids = itemIdsByName.get(normalizeName(resolvedName));
  const idsList = [...(ids ?? [])];
  if (idsList.length === 1) {
    const resolved = itemByIdentity.get(idsList[0] as string);
    if (resolved) return { ...resolved, ...(itemCount === undefined ? {} : { itemCount }), resolution: "unique_name_match" };
  }
  const nameZh = text(entry, "itemZh") ?? zhByEnglishName.get(normalizeName(resolvedName)) ?? "";
  return {
    uniqueName: "",
    name: resolvedName,
    nameZh,
    ...(itemCount === undefined ? {} : { itemCount }),
    resolution: idsList.length > 1 ? "ambiguous_name" : "unresolved_name",
  };
}

function buildRewardIndexes(relics: Map<string, Relic>): Map<string, Map<string, Map<string, number[]>>> {
  const index = new Map<string, Map<string, Map<string, number[]>>>();
  for (const [relicId, relic] of relics) {
    const states = new Map<string, Map<string, number[]>>();
    for (const [refinement, state] of Object.entries(relic.states)) {
      const rewards = new Map<string, number[]>();
      state.rewards.forEach((reward, rewardIndex) => {
        const identity = text(reward, "rewardName");
        if (!identity) throw new Error(`${relicId}/${refinement}: reward lacks rewardName`);
        const key = canonicalIdentity(identity);
        const indexes = rewards.get(key) ?? [];
        indexes.push(rewardIndex);
        rewards.set(key, indexes);
      });
      states.set(refinement, rewards);
    }
    index.set(relicId, states);
  }
  return index;
}

function resolveRelicCandidates(
  relicIds: string[],
  refinement: string,
  item: ItemReference,
  rewardIndexes: Map<string, Map<string, Map<string, number[]>>>,
): string[] {
  if (relicIds.length <= 1) return relicIds;
  const rewardMatches = item.uniqueName
    ? relicIds.filter((id) => rewardIndexes.get(id)?.get(refinement)?.has(canonicalIdentity(item.uniqueName)))
    : [];
  if (rewardMatches.length > 0) return rewardMatches;
  const sets = relicIds.map((id) => [...(rewardIndexes.get(id)?.get(refinement)?.keys() ?? [])].sort().join("\n"));
  return sets.every((set) => set === sets[0]) ? relicIds : [];
}

function resolveRefinement(
  relicIds: string[],
  requested: string,
  relics: Map<string, Relic>,
): string {
  if (relicIds.every((id) => relics.get(id)?.states[requested])) return requested;
  if (relicIds.length === 1) {
    const states = Object.keys(relics.get(relicIds[0] as string)?.states ?? {});
    if (states.length === 1 && states[0] === "Default") return "Default";
  }
  return requested;
}

function dropTableRecord(entry: JsonObject, item: ItemReference & { resolution: string }): JsonObject {
  return {
    category: text(entry, "category") ?? "",
    source: text(entry, "source") ?? "",
    groups: Array.isArray(entry.groups) ? entry.groups : [],
    item: {
      ...(item.uniqueName ? { uniqueName: item.uniqueName } : {}),
      name: item.name,
      nameZh: item.nameZh,
      ...(item.itemCount === undefined ? {} : { itemCount: item.itemCount }),
      ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
      resolution: item.resolution,
    },
    rarity: text(entry, "rarity") ?? "",
    probability: percentProbability(number(entry, "chance")),
    dropChancePercent: number(entry, "chance") ?? null,
      chanceResolution: number(entry, "chance") === undefined ? "unparsed" : /Under Review/iu.test(String(entry.rarity)) ? "under_review" : "parsed",
      ...(entry.sourceChanceText === undefined ? {} : { sourceChanceText: entry.sourceChanceText }),
  };
}

function findMarketListings(
  relicUniqueName: string,
  states: Record<string, RelicState>,
  marketItems: JsonObject[],
): JsonObject[] {
  const identities = new Set([
    canonicalIdentity(relicUniqueName),
    ...Object.values(states).map((state) => canonicalIdentity(String(state.uniqueName ?? ""))),
  ]);
  return marketItems.filter((item) => identities.has(canonicalIdentity(text(item, "gameRef") ?? ""))
    && typeof item.slug === "string").map((item) => ({
    gameRef: text(item, "gameRef") ?? "",
    slug: text(item, "slug") ?? "",
    url: `https://warframe.market/items/${text(item, "slug") ?? ""}`,
    iconUrl: marketAssetUrl(text(item, "icon") ?? ""),
    name: text(optionalObject(optionalObject(item.i18n).en), "name") ?? text(item, "name") ?? "",
    nameZh: text(optionalObject(optionalObject(item.i18n).zh), "name") ?? "",
  }));
}

function buildEnglishToChinese(en: JsonObject, zh: JsonObject): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const [key, english] of Object.entries(en)) {
    const chinese = zh[key];
    if (typeof english !== "string" || typeof chinese !== "string" || english === "" || chinese === "") continue;
    const normalized = normalizeName(english);
    const values = candidates.get(normalized) ?? new Set<string>();
    values.add(chinese);
    candidates.set(normalized, values);
  }
  return new Map([...candidates].flatMap(([name, values]) => values.size === 1 ? [[name, [...values][0] as string]] : []));
}

function parseRelicSource(source: string): { name: string; refinement: string } | undefined {
  const match = /^(.*?)\s*\((Intact|Exceptional|Flawless|Radiant)\)\s*$/iu.exec(source);
  if (!match?.[1] || !match[2]) return undefined;
  const refinement = ["Intact", "Exceptional", "Flawless", "Radiant"]
    .find((value) => value.toLowerCase() === match[2]?.toLowerCase());
  return refinement ? { name: match[1].trim(), refinement } : undefined;
}

function relicTier(uniqueName: string): number | null {
  const match = /\/Projections\/T(\d+)VoidProjection/u.exec(uniqueName);
  return match?.[1] ? Number(match[1]) : null;
}

function relicCode(name: string): string {
  return name.replace(/\s+Relic$/iu, "").split(/\s+/u).slice(1).join(" ");
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function canonicalIdentity(value: string): string {
  return value.replace("/Lotus/StoreItems/", "/Lotus/");
}

function marketAssetUrl(path: string): string {
  return path ? `https://warframe.market/static/assets/${path}` : "";
}

function readExportArray(files: DatasetFileInput[], path: string, key: string): JsonObject[] {
  const root = readObject(files, path);
  const values = root[key];
  if (!Array.isArray(values)) throw new Error(`Expected ${key} array in ${path}`);
  return values.map((value, index) => asObject(value, `${path}/${key}[${index}]`));
}

function readArray(files: DatasetFileInput[], path: string): JsonObject[] {
  const file = findFile(path, files);
  const value = JSON.parse(asText(file.content)) as unknown;
  if (!Array.isArray(value)) throw new Error(`Expected array in ${path}`);
  return value.map((record, index) => asObject(record, `${path}[${index}]`));
}

function readObject(files: DatasetFileInput[], path: string): JsonObject {
  const file = findFile(path, files);
  const value = JSON.parse(asText(file.content)) as unknown;
  return asObject(value, path);
}

function findFile(path: string, files: DatasetFileInput[]): DatasetFileInput {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Relic projection input is missing: ${path}`);
  return file;
}

function asText(content: Buffer | string): string {
  return Buffer.isBuffer(content) ? content.toString("utf8") : content;
}

function asObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredText(value: JsonObject, key: string, context: string): string {
  const result = text(value, key);
  if (result === undefined || result === "") throw new Error(`${context} lacks ${key}`);
  return result;
}

function text(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function number(value: JsonObject, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] as number : undefined;
}
