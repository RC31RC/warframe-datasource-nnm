type Obj = Record<string, unknown>;
const DISPLAY_FIELDS = new Set(["uniqueName", "recordKey", "name", "nameEn", "nameZh", "description", "descriptionZh", "iconUrl", "iconStatus", "resultItem", "resultTypeNameZh", "nameKey", "descriptionEn", "descriptionKey", "icon", "identityAliases"]);

/** Alias only records with identical complete manufacturing behavior, including result identity. */
export function consolidateRecipes(recipes: Record<string, Obj>): Record<string, Obj> {
  const groups = new Map<string, string[]>();
  for (const [id, recipe] of Object.entries(recipes)) {
    const behavior = Object.fromEntries(Object.entries(recipe).filter(([key]) => !DISPLAY_FIELDS.has(key)));
    const signature = JSON.stringify(stable(behavior));
    groups.set(signature, [...(groups.get(signature) ?? []), id]);
  }
  const result: Record<string, Obj> = {};
  for (const ids of groups.values()) {
    ids.sort();
    const canonical = ids[0]!;
    const aliases = new Set(ids.slice(1));
    for (const id of ids) {
      const previous = recipes[id]?.identityAliases;
      if (Array.isArray(previous)) for (const alias of previous) if (typeof alias === "string" && alias !== canonical) aliases.add(alias);
    }
    result[canonical] = { ...recipes[canonical], ...(aliases.size ? { identityAliases: [...aliases].sort() } : {}) };
  }
  return result;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, stable(child)]));
}
