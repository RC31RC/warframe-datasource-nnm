import type { DatasetFileInput } from "../domain/contracts.js";

type Obj = Record<string, unknown>;
export const canonicalIdentity = (value: string): string => value.replace("/Lotus/StoreItems/", "/Lotus/");
export const normalizeName = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
export function object(value: unknown): Obj { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {}; }
export function read(file: DatasetFileInput): unknown { return JSON.parse(String(file.content)) as unknown; }

/** A bounded index: references contain labels and icons, never another complete entity graph. */
export function identityDetails(files: DatasetFileInput[]): Map<string, Obj> {
  const result = new Map<string, Obj>();
  const add = (key: string, value: Obj, domain: string, canonicalKey = key) => {
    if (!key.startsWith("/Lotus/")) return;
    const en = object(value.en), zh = object(value.zh);
    const name = string(value.nameEn) || string(en.name) || string(value.name) || string(value.abilityName);
    const nameZh = string(zh.name) || string(value.nameZh) || string(value.abilityNameZh);
    const identity = canonicalIdentity(key);
    const previous = result.get(identity) ?? {};
    const readable = name && !name.startsWith("/");
    const iconUrl = string(value.iconUrl) || string(value.abilityIconUrl);
    result.set(identity, {
      ...previous,
      uniqueName: canonicalIdentity(canonicalKey),
      name: previous.name || (readable ? name : ""),
      nameZh: previous.nameZh || (nameZh.startsWith("/") ? "" : nameZh),
      ...(iconUrl && !/unknown|placeholder/iu.test(iconUrl) ? { iconUrl } : {}),
      domain: previous.domain ?? domain,
      resolution: "stable_identity",
    });
  };
  for (const file of files) {
    if (file.stage !== "cleaned" || !file.path.endsWith(".json") || file.path.startsWith("languages/")) continue;
    const domain = file.path.split("/")[0] ?? "entity";
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      const record = value as Obj;
      const id = string(record.uniqueName) || string(record.gameRef);
      if (id) add(id, record, domain);
      if (Array.isArray(record.identityAliases)) for (const alias of record.identityAliases) if (typeof alias === "string") add(alias, record, domain, string(record.uniqueName) || alias);
      for (const [key, child] of Object.entries(record)) {
        if (key.startsWith("/Lotus/") && child && typeof child === "object" && !Array.isArray(child)) add(key, object(child), domain);
        if (!/^(translations|i18n|itemReferences)$/u.test(key)) visit(child);
      }
    };
    visit(read(file));
  }
  return result;
}

/** Select only proven ordinary identities; retain any remaining ambiguity. */
export function ordinaryCandidates(ids: string[], name: string): string[] {
  if (ids.length <= 1) return ids;
  if (ids.every((id) => /\/Projections\/.*(?:Bronze|Silver|Gold|Platinum)$/u.test(id))) {
    return [...new Set(ids.map((id) => id.replace(/(?:Bronze|Silver|Gold|Platinum)$/u, "")))];
  }
  const overrides: Record<string, string> = {
    "pressure point": "/Lotus/Upgrades/Mods/Melee/WeaponMeleeDamageMod",
    adaptation: "/Lotus/Upgrades/Mods/Warframe/AvatarResistanceOnDamageMod",
    "sure shot": "/Lotus/Upgrades/Mods/Pistol/WeaponStunChanceMod",
  };
  const explicit = overrides[normalizeName(name)];
  if (explicit && ids.includes(explicit)) return [explicit];
  const ordinary = ids.filter((id) => !/\/(?:Beginner|Intermediate|Expert|Nemesis)\/|PvPVariant|Doppelganger|OnHeavyKill|(?:\d+Pack|StarterPack|TutorialQuest|RaidTutorial|JunctionReward)$/u.test(id));
  return ordinary.length === 1 ? ordinary : ids;
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
