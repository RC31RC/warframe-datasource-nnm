import { DOCUMENT_PRODUCTS, SECTION_MAP_PRODUCTS, isRecordMap } from "../projections/compact.js";

export interface ProductStructure {
  recordDepth: number;
  tables: number;
  tablePaths: string[];
  scalarLeaves: number;
  arrays: number;
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Structural relation-path count only, NOT consumer DDL or an upper/lower bound;
 * independent collection/field paths are counted separately.
 * includes primitive arrays, keyed maps and document metadata; no cross-file dedup.
 * A recursively nested `groups` collection is ONE self-referencing group table.
 * Unknown objects count as separate tables; empty optional objects do not.
 */
export function analyzeProductStructure(value: unknown, file: string): ProductStructure {
  const tables = new Set<string>();
  let recordDepth = 1, scalarLeaves = 0, arrays = 0;
  const normalize = (path: string[]): string => {
    const out: string[] = [];
    for (const part of path) {
      // Group recursion has the same schema, not a new table for each tree depth.
      if (part === "groups" && out.includes("groups")) out.splice(out.indexOf("groups") + 1);
      else out.push(part);
    }
    return out.join(".") || "$";
  };
  const add = (path: string[]) => tables.add(normalize(path));
  const map = (v: unknown, path: string[], depth: number) => {
    add(path);
    if (!obj(v)) return;
    for (const child of Object.values(v)) {
      if (file === "worldstate/activities.json" && path.at(-1)?.split("__").at(-1) === "missionVariants") {
        map(child, [...path, "variants"], depth + 1);
      } else if (Array.isArray(child)) collection(child, [...path, "[]"], depth + 1);
      else record(child, path, depth);
    }
  };
  const collection = (v: unknown[], path: string[], depth: number) => {
    arrays += 1;
    add(path);
    recordDepth = Math.max(recordDepth, depth);
    for (const child of v) {
      if (file === "worldstate/activities.json" && path.at(-1)?.split("__").at(-1) === "missionVariants") {
        map(child, [...path, "variants"], depth + 1);
      } else if (Array.isArray(child)) collection(child, [...path, "[]"], depth + 1);
      else record(child, path, depth);
    }
  };
  const record = (v: unknown, path: string[], depth: number) => {
    if (!obj(v)) { scalarLeaves += 1; return; }
    recordDepth = Math.max(recordDepth, depth);
    for (const [key, child] of Object.entries(v)) {
      const childPath = [...path, key];
      const originalField = key.split("__").at(-1) ?? key;
      if (Array.isArray(child)) collection(child, childPath, depth + 1);
      else if (obj(child)) {
        if (isRecordMap(file, originalField)) map(child, childPath, depth + 1);
        else if (Object.keys(child).length) { add(childPath); record(child, childPath, depth + 1); }
      } else scalarLeaves += 1;
    }
  };
  if (Array.isArray(value)) collection(value, [], 1);
  else if (obj(value)) {
    if (SECTION_MAP_PRODUCTS.has(file)) {
      for (const [section, rows] of Object.entries(value)) map(rows, [section], 1);
    } else if (DOCUMENT_PRODUCTS.has(file)) { add([]); record(value, [], 1); }
    else { add([]); map(value, [], 1); }
  }
  return { recordDepth, tables: tables.size, tablePaths: [...tables].sort(), scalarLeaves, arrays };
}
