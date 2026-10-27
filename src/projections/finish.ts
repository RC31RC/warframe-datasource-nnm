import type { DatasetFileInput } from "../domain/contracts.js";
import { canonicalIdentity, identityDetails, object, read } from "./identity.js";

type Obj = Record<string, unknown>;
/** Shared display contract and truthful icon status; raw protocol fields remain intact. */
export function finishProducts(files: DatasetFileInput[], publicExport: DatasetFileInput[]): DatasetFileInput[] {
  const byIdentity = identityDetails(files);
  const imageFile = files.find((file) => file.path === "plus/images.json");
  const images = imageFile ? object(read(imageFile)) : {};
  const manifestFile = publicExport.find((file) => file.path === "public-export/shared/ExportManifest.json");
  const assets = new Map<string, string>();
  const manifest = manifestFile ? object(read(manifestFile)).Manifest : [];
  if (Array.isArray(manifest)) for (const raw of manifest) {
    const record = object(raw);
    if (typeof record.textureLocation === "string") {
      const url = `https://content.warframe.com/PublicExport/${record.textureLocation.replace(/^\//u, "")}`;
      assets.set(String(record.uniqueName), url);
      const assetPath = (record.textureLocation.split("!")[0] ?? record.textureLocation).replace(/^\//u, "");
      assets.set(assetPath, url);
    }
  }
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Obj;
    const next = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, key === "i18n" || key === "translations" ? child : visit(child)]));
    if (!next.name && typeof record.abilityName === "string") next.name = record.abilityName;
    if (!next.nameZh && record.abilityNameZh) next.nameZh = record.abilityNameZh;
    const id = typeof record.uniqueName === "string" ? record.uniqueName : typeof record.gameRef === "string" ? record.gameRef : "";
    const details = id ? byIdentity.get(canonicalIdentity(id)) : undefined;
    if (!next.nameZh && details?.nameZh) next.nameZh = details.nameZh;
    if (!next.name && details?.name) next.name = details.name;
    if (!next.nameEn && typeof next.name === "string" && !next.name.startsWith("/")) next.nameEn = next.name;
    if (record.gameItem && !record.nameZh) next.nameZh = object(record.gameItem).nameZh ?? details?.nameZh ?? "";
    if (Array.isArray(record.marketListings)) next.marketListings = (next.marketListings as Obj[]).map((listing) => ({ ...listing, nameZh: listing.nameZh || next.nameZh || "" }));
    const rawIcon = [record.iconUrl, record.abilityIconUrl, details?.iconUrl, record.icon, record.iconTexture, record.image].find((x) => typeof x === "string" && !!x && !/unknown|placeholder/iu.test(x));
    if (typeof rawIcon === "string") {
      const assetPath = rawIcon.replace(/^\//u, "");
      let url = /^https:\/\//u.test(rawIcon) ? rawIcon : assets.get(assetPath);
      const image = object(images[rawIcon] ?? images[assetPath] ?? images[`/${assetPath}`]);
      if (!url && typeof image.contentHash === "string" && /^[A-Za-z0-9+_\-=]+$/u.test(image.contentHash)) {
        url = `https://content.warframe.com/PublicExport/${assetPath}!${image.contentHash}`;
      }
      if (url) { next.iconUrl = url; next.iconStatus = "available"; }
      else { delete next.iconUrl; next.iconStatus = "internal_asset_only"; next.iconAsset = rawIcon; }
    } else if (record.iconStatus === "missing" || id || record.abilityName) {
      delete next.iconUrl;
      next.iconStatus = "missing";
    }
    for (const field of ["iconUrl", "thumbUrl"]) if (/unknown|placeholder/iu.test(String(next[field] ?? ""))) { delete next[field]; next.iconStatus = "missing"; }
    return next;
  };
  return files.map((file) => file.path.startsWith("languages/") || /^(?:catalog\/i18n|localization)\//u.test(file.path) || file.path === "plus/images.json" ? file : {
    ...file, content: `${JSON.stringify(visit(read(file)), null, 2)}\n`,
  });
}
