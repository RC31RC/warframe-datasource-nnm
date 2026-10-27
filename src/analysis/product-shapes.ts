import { DOCUMENT_PRODUCTS, SECTION_MAP_PRODUCTS, isRecordMap } from "../projections/compact.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const type = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
interface Observation { types: Set<string>; records: number; shapes: Set<string>; fields: Map<string, number> }

/** Missing optional columns are distinguished from an actual union of incompatible JSON types. */
export function analyzeProductShapes(value: unknown, file: string) {
  const paths = new Map<string, Observation>();
  const visit = (row: unknown, path: string) => {
    const observation = paths.get(path) ?? { types: new Set<string>(), records: 0, shapes: new Set<string>(), fields: new Map<string, number>() };
    paths.set(path, observation);
    observation.types.add(type(row));
    if (Array.isArray(row)) {
      for (const child of row) visit(child, `${path}[]`);
    } else if (object(row)) {
      observation.records += 1;
      observation.shapes.add(JSON.stringify(Object.keys(row).sort()));
      for (const [field, child] of Object.entries(row)) {
        observation.fields.set(field, (observation.fields.get(field) ?? 0) + 1);
        const childPath = `${path}.${field}`;
        if (isRecordMap(file, field.split("__").at(-1) ?? field) && object(child)) {
          for (const item of Object.values(child)) visit(item, `${childPath}{}`);
        } else visit(child, childPath);
      }
    }
  };
  if (Array.isArray(value)) for (const row of value) visit(row, "$");
  else if (object(value)) {
    if (DOCUMENT_PRODUCTS.has(file)) visit(value, "$");
    else if (SECTION_MAP_PRODUCTS.has(file)) {
      for (const [section, rows] of Object.entries(value)) {
        if (object(rows)) for (const row of Object.values(rows)) visit(row, `$.${section}{}`);
        else visit(rows, `$.${section}`);
      }
    } else for (const row of Object.values(value)) visit(row, "$");
  } else visit(value, "$");
  const mixedTypes = [...paths].filter(([, observation]) => [...observation.types].filter((kind) => kind !== "null").length > 1)
    .map(([path, observation]) => ({ path, types: [...observation.types].sort() }));
  const varyingFieldSets = [...paths].filter(([, observation]) => observation.shapes.size > 1)
    .map(([path, observation]) => ({ path, records: observation.records, shapes: observation.shapes.size,
      optionalFields: [...observation.fields].filter(([, count]) => count < observation.records).map(([field]) => field).sort() }));
  return { mixedTypes, varyingFieldSets };
}
