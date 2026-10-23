import { isDeepStrictEqual } from "node:util";
import type { DatasetFileInput } from "../domain/contracts.js";
import { canonicalProductPath } from "../publish/product-layout.js";
import { object, read } from "./identity.js";

type Obj = Record<string, unknown>;

/** 官方类型祖先与业务集合的精确关系；不根据物品名称或名称前缀猜归属。 */
const TYPE_DESTINATIONS: Readonly<Record<string, string>> = {
  "/Lotus/Types/Items/ShipDecos/ShipDecoItem": "items/decorations.json",
  "/Lotus/Types/Items/ShipDecos/ChildDrawingBase": "items/decorations.json",
  "/Lotus/Types/Items/FusionTreasure": "items/ayatan-treasures.json",
  "/Lotus/Types/Items/ShipItem": "equipment/ships.json",
  "/Lotus/Types/Game/CrewShip/CrewShip": "equipment/ships.json",
  "/Lotus/Types/Items/MiscItems/WarframeComponentItem": "items/components.json",
  "/Lotus/Types/Items/MiscItems/ArchwingComponentItem": "items/components.json",
  "/Lotus/Types/Items/MiscItems/ShipComponentItem": "items/components.json",
  "/Lotus/Types/Items/MiscItems/PhotoboothTile": "items/captura-scenes.json",
  "/Lotus/Types/Game/PhotoboothTileItem": "items/captura-scenes.json",
  "/Lotus/Types/Game/SongItem": "items/songs.json",
  "/Lotus/Types/Items/MiscItems/ResourceItem": "items/resources.json",
  "/Lotus/Types/Items/Gems/GemItem": "items/resources.json",
  "/Lotus/Types/Items/Fish/FishPartItem": "items/resources.json",
  "/Lotus/Types/Items/Plants/MiscItems/PlantItem": "items/resources.json",
  "/Lotus/Types/Items/Research/SampleBase": "items/resources.json",
};

/** 官方 productCategory 能直接证明的业务归属；MiscItems 不能直接视为材料。 */
const CATEGORY_DESTINATIONS: Readonly<Record<string, string>> = {
  ShipDecorations: "items/decorations.json",
  FusionTreasures: "items/ayatan-treasures.json",
  SupplyDrop: "items/supply-drops.json",
  Ships: "equipment/ships.json",
  CrewShips: "equipment/ships.json",
};

/**
 * 重分配混在 Resources/Flavour 中的实体，保持每个记录原字段、原值与稳定身份。
 * 缺少类型证据的资源域条目进入 misc-items；内部基类仍留在 internal-definitions。
 */
export function organizeEntityOwnership(files: DatasetFileInput[]): DatasetFileInput[] {
  const managed = new Set(["items/resources.json", "items/skins.json", "items/customizations.json"]);
  if (!files.some((file) => file.stage === "cleaned" && managed.has(canonicalProductPath(file.path)))) return files;

  // 只读取已有完整实体及内部类型定义；缺失父类、循环继承和多父类均有界处理。
  const parents = new Map<string, Set<string>>();
  for (const file of files) {
    if (file.stage !== "cleaned") continue;
    const path = canonicalProductPath(file.path);
    if (!managed.has(path) && path !== "items/internal-definitions.json") continue;
    for (const [id, value] of Object.entries(object(read(file)))) {
      const record = object(value);
      const ancestors = parents.get(id) ?? new Set<string>();
      for (const parent of [record.parentName, record.base]) if (typeof parent === "string" && parent) ancestors.add(parent);
      parents.set(id, ancestors);
    }
  }
  const lineage = (record: Obj): Set<string> => {
    const visited = new Set<string>();
    const queue = [record.parentName, record.base].filter((value): value is string => typeof value === "string" && !!value);
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i]!;
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push(...(parents.get(id) ?? []));
    }
    return visited;
  };
  const resourceDestination = (record: Obj): string => {
    const category = typeof record.productCategory === "string" ? CATEGORY_DESTINATIONS[record.productCategory] : undefined;
    if (category) return category;
    const candidates = new Set([...lineage(record)].map((type) => TYPE_DESTINATIONS[type]).filter((value): value is string => !!value));
    if (candidates.size === 1) return [...candidates][0]!;
    // 不把未知类别或多个相互矛盾的父类默认为材料；原类型字段继续保留供讨论。
    return "items/misc-items.json";
  };

  const grouped = new Map<string, { rows: Map<string, unknown>; template: DatasetFileInput; inputs: Set<string> }>();
  const output: DatasetFileInput[] = [];
  const insert = (path: string, id: string, value: unknown, file: DatasetFileInput) => {
    const bucket = grouped.get(path) ?? { rows: new Map<string, unknown>(), template: file, inputs: new Set<string>() };
    if (bucket.rows.has(id) && !isDeepStrictEqual(bucket.rows.get(id), value)) throw new Error(`Conflicting entity ownership record: ${path}: ${id}`);
    bucket.rows.set(id, value);
    for (const input of file.source.derivedFrom ?? []) bucket.inputs.add(input);
    grouped.set(path, bucket);
  };
  for (const file of files) {
    const path = canonicalProductPath(file.path);
    if (file.stage !== "cleaned" || !managed.has(path)) { output.push(file); continue; }
    const root = read(file);
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error(`Expected keyed entity collection: ${file.path}`);
    // 源集合为空也保留空对象入口；不能因空输入丢失一个已定义的数据集。
    if (Object.keys(root).length === 0 && !grouped.has(path)) grouped.set(path, { rows: new Map(), template: file, inputs: new Set(file.source.derivedFrom ?? []) });
    for (const [id, value] of Object.entries(root)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected entity object: ${file.path}: ${id}`);
      const record = object(value);
      const target = path === "items/resources.json" ? resourceDestination(record)
        : path === "items/customizations.json" && lineage(record).has("/Lotus/Types/Items/ShipExteriorSkinItem") ? "items/skins.json" : path;
      insert(target, id, value, file);
    }
  }
  // 防止将新增分组覆盖调用方已有的非托管集合；冲突必须明确报错。
  const existing = new Set(output.filter((file) => file.stage === "cleaned").map((file) => canonicalProductPath(file.path)));
  for (const [path, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (existing.has(path)) throw new Error(`Conflicting entity ownership destination: ${path}`);
    const content = Object.fromEntries([...group.rows].sort(([a], [b]) => a.localeCompare(b, "en")));
    output.push({ ...group.template, path, content: `${JSON.stringify(content, null, 2)}\n`, recordCount: group.rows.size,
      source: { ...group.template.source, derivedFrom: [...group.inputs].sort() } });
  }
  return output;
}
