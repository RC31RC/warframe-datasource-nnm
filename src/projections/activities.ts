import type { DatasetFileInput } from "../domain/contracts.js";
import { object, read } from "./identity.js";

type Obj = Record<string, unknown>;
/** Exact client key families; ambiguous names stay in separate activity namespaces. */
export function projectActivityDefinitions(languages: DatasetFileInput[]): DatasetFileInput[] {
  const enFile = languages.find((file) => file.path === "languages/en.json"), zhFile = languages.find((file) => file.path === "languages/zh.json");
  if (!enFile || !zhFile) return [];
  const en = object(read(enFile)), zh = object(read(zhFile));
  const condition: Obj = {}, personalModifiers: Obj = {}, variants: Obj = {}, descentChallenges: Obj = {}, descentModes: Obj = {}, protoframes: Obj = {};
  const entry = (key: string): Obj => {
    const descriptionKey = [`${key}_Desc`, `${key}Desc`].find((key) => typeof en[key] === "string" || typeof zh[key] === "string");
    return { nameKey: key, nameEn: en[key] ?? "", nameZh: zh[key] ?? "", ...(descriptionKey ? { descriptionKey, descriptionEn: en[descriptionKey] ?? "", descriptionZh: zh[descriptionKey] ?? "" } : {}) };
  };
  for (const key of [...new Set([...Object.keys(en), ...Object.keys(zh)])].sort()) {
    if (/(?:_Desc|Desc)$/u.test(key)) continue;
    const con = /^\/Lotus\/Language\/Conquest\/Condition_([A-Za-z0-9]+)$/u.exec(key)?.[1];
    if (con) condition[con] = entry(key);
    const personal = /^\/Lotus\/Language\/Conquest\/PersonalMod_([A-Za-z0-9]+)$/u.exec(key)?.[1];
    if (personal) personalModifiers[personal] = entry(key);
    const variant = /^\/Lotus\/Language\/Conquest\/MissionVariant_(LabConquest|HexConquest)_([A-Za-z0-9]+)$/u.exec(key);
    if (variant) { const namespace = variants[variant[1]!] ?? {}; object(namespace)[variant[2]!] = entry(key); variants[variant[1]!] = namespace; }
    const challenge = /^\/Lotus\/Language\/CircleOfHell\/CoHChallenge([A-Za-z0-9]+)$/u.exec(key)?.[1];
    if (challenge) descentChallenges[challenge] = entry(key);
    const mode = /^\/Lotus\/Language\/CircleOfHell\/CoHGamemode([A-Za-z0-9]+)$/u.exec(key)?.[1];
    if (mode) descentModes[mode] = entry(key);
    const protoframe = /^\/Lotus\/Language\/CircleOfHell\/CoHProtoframe([A-Za-z0-9]+)$/u.exec(key)?.[1];
    if (protoframe) protoframes[protoframe] = entry(key);
  }
  const types: Obj = {};
  for (const [code, key] of [["CT_LAB", "/Lotus/Language/Conquest/SolarMapLabConquestNode"], ["CT_HEX", "/Lotus/Language/1999/ConquestSetup_Title"]] as const) {
    if (typeof en[key] === "string" || typeof zh[key] === "string") types[code] = entry(key);
  }
  const data = { conquests: { types, conditions: condition, personalModifiers, missionVariants: variants }, descents: { challenges: descentChallenges, gameModes: descentModes, protoframes } };
  const path = "worldstate/activities.json";
  return [{ stage: "cleaned", path, content: `${JSON.stringify(data, null, 2)}\n`, recordCount: Object.keys(types).length + Object.keys(personalModifiers).length + Object.keys(protoframes).length + Object.keys(condition).length + Object.values(variants).reduce<number>((n, values) => n + Object.keys(object(values)).length, 0) + Object.keys(descentChallenges).length + Object.keys(descentModes).length,
    source: { ...enFile.source, dataset: path, derivedFrom: [enFile.path, zhFile.path], transformer: "warframe-datasource-nnm/activity-definitions@1" } }];
}
