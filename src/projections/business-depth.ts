import type { DatasetFileInput } from "../domain/contracts.js";
import { object, read } from "./identity.js";

type Obj = Record<string, unknown>;
const label = (entity: Obj) => ({ uniqueName: entity.uniqueName, nameEn: entity.nameEn ?? entity.name, nameZh: entity.nameZh ?? "", ...(entity.icon ? { icon: entity.icon } : {}) });

/** Express domains by their actual business content, rather than requiring every definition to have an item name. */
export function enrichBusinessDepth(files: DatasetFileInput[]): DatasetFileInput[] {
  const modsFile = files.find((file) => file.path === "catalog/upgrades/mods.json");
  const modRoot = modsFile ? read(modsFile) : {};
  const mods = Array.isArray(modRoot) ? Object.fromEntries(modRoot.map((value) => [String(object(value).uniqueName), value])) : object(modRoot);
  const members = new Map<string, Obj[]>();
  for (const [id, raw] of Object.entries(mods)) {
    const mod = object(raw);
    if (typeof mod.modSet !== "string") continue;
    members.set(mod.modSet, [...(members.get(mod.modSet) ?? []), label({ ...mod, uniqueName: id })]);
  }
  const factionsFile = files.find((file) => file.path === "worldstate/factions.json");
  const factions = factionsFile ? object(read(factionsFile)) : {};
  const missionFile = files.find((file) => file.path === "worldstate/mission-types.json");
  const missions = missionFile ? object(read(missionFile)) : {};
  return files.map((file) => {
    if (!["catalog/upgrades/mod-sets.json", "commerce/fusion-bundles.json", "plus/emailitems.json", "plus/tilesets.json"].includes(file.path)) return file;
    const root = read(file), isArray = Array.isArray(root);
    const rows = isArray ? Object.fromEntries(root.map((value) => [String(object(value).uniqueName), value])) : object(root);
    for (const [id, value] of Object.entries(rows)) {
      const record = object(value);
      if (file.path.endsWith("mod-sets.json")) record.members = (members.get(id) ?? []).sort((a, b) => String(a.uniqueName).localeCompare(String(b.uniqueName), "en"));
      if (file.path.endsWith("fusion-bundles.json") && typeof record.fusionPoints === "number") {
        record.quantity = record.fusionPoints;
        record.currency = "endo";
        record.displayNameEn = `${record.fusionPoints.toLocaleString("en-US")} Endo`;
        record.displayNameZh = `${record.fusionPoints.toLocaleString("en-US")} 内融核心`;
      }
      if (file.path === "plus/emailitems.json") {
        const message = object(record.message);
        if (message.titleEn) record.displayNameEn = message.titleEn;
        if (message.titleZh) record.displayNameZh = message.titleZh;
      }
      if (file.path === "plus/tilesets.json") {
        if (record.faction) {
          const faction = object(factions[String(record.faction)]);
          if (faction.name) record.factionNameEn = faction.name;
          if (faction.nameZh) record.factionNameZh = faction.nameZh;
        }
        record.missionDefinitions = Object.entries(object(record.missions)).map(([key, raw]) => {
          const mission = object(missions[key]);
          return { ...object(raw), missionType: key, nameEn: mission.nameEn ?? mission.name ?? "", nameZh: mission.nameZh ?? "" };
        });
      }
      rows[id] = record;
    }
    return { ...file, content: `${JSON.stringify(isArray ? Object.values(rows) : rows, null, 2)}\n` };
  });
}
