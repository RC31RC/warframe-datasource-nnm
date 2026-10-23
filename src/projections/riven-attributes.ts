import type { DatasetFileInput } from "../domain/contracts.js";
import { object, read } from "./identity.js";

/** Join stable official tags, preserving each weapon class's signed numeric parameters. */
export function enrichRivenAttributes(files: DatasetFileInput[], definitions: DatasetFileInput[]): DatasetFileInput[] {
  const definition = definitions.find((file) => file.path === "riven/definitions.json");
  if (!definition) throw new Error("Missing riven definitions");
  const byTag = new Map<string, Record<string, unknown>[]>();
  for (const raw of read(definition) as unknown[]) {
    const record = object(raw);
    for (const rawEntry of record.upgradeEntries as unknown[]) {
      const entry = object(rawEntry);
      if (typeof entry.tag !== "string") continue;
      const values = byTag.get(entry.tag) ?? [];
      values.push({ rivenUniqueName: record.uniqueName, rivenName: record.name, rivenNameZh: record.nameZh,
        ...entry, parameterSemantics: "signed_per_class_upgrade_parameters" });
      byTag.set(entry.tag, values);
    }
  }
  return files.map((file) => {
    if (file.stage !== "cleaned" || file.path !== "market/riven-attributes.json") return file;
    const records = (read(file) as unknown[]).map((raw) => {
      const record = object(raw), i18n = object(record.i18n), en = object(i18n.en);
      const entries = byTag.get(String(record.gameRef)) ?? [];
      const templates = [...new Set(entries.flatMap((entry) => (entry.upgradeValues as unknown[]).map((value) => object(value).locTagZh)).filter((value): value is string => typeof value === "string" && !!value))];
      const chinese = templates.map((value) => value.replace(/\|val\|\s*%?\s*/gu, "").replace(/<[^>]*>/gu, "").trim());
      const name = typeof en.name === "string" ? en.name : String(record.effect ?? record.slug);
      const nameZh = chinese[0] ?? "";
      // Placeholder images carry no attribute information; publish their status explicitly.
      const locales = Object.fromEntries(Object.entries(i18n).map(([locale, rawValue]) => {
        const value = { ...object(rawValue) };
        for (const field of ["icon", "thumb"]) if (/unknown|placeholder/iu.test(String(value[field] ?? ""))) delete value[field];
        return [locale, value];
      }));
      const { exclusive_to: _legacy, ...next } = record;
      return { ...next, name, nameEn: name, nameZh, effectZh: nameZh,
        i18n: { ...locales, ...(nameZh ? { zh: { ...object(locales.zh), name: nameZh } } : {}) },
        ...(Object.values(locales).some((value) => object(value).icon || object(value).thumb)
          ? { iconStatus: "available" } : { iconStatus: "missing", iconReason: "no_attribute_specific_image" }),
        officialEntries: entries, templatesZh: templates,
        definitionResolution: entries.length ? "exact_game_tag" : "unresolved",
        valueSemantics: "upgrade_parameter_not_probability",
      };
    });
    return { ...file, content: `${JSON.stringify(records, null, 2)}\n`, recordCount: records.length };
  });
}
