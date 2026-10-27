import { isDeepStrictEqual } from "node:util";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);

/** Pure coverage check and removal: caller rejects partial coverage before publishing. */
export function previewRedundantMissions(value: unknown): { value: unknown; checked: number; removable: number } {
  if (!object(value)) return { value, checked: 0, removable: 0 };
  let checked = 0, removable = 0;
  const rows = Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    if (!object(raw) || !object(raw.missions) || !Array.isArray(raw.missionDefinitions)) return [key, raw];
    checked += 1;
    const definitions = raw.missionDefinitions;
    const exact = Object.entries(raw.missions).every(([type, record]) => {
      if (!object(record)) return false;
      const matches = definitions.filter((row) => object(row) && row.missionType === type);
      if (matches.length !== 1) return false;
      const match = matches[0] as Obj;
      return Object.entries(record).every(([field, item]) => Object.hasOwn(match, field) && isDeepStrictEqual(item, match[field]));
    });
    if (!exact || definitions.length !== Object.keys(raw.missions).length) return [key, raw];
    removable += 1;
    const { missions: _duplicate, ...row } = raw;
    return [key, row];
  }));
  return { value: rows, checked, removable };
}
