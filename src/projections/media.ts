import type { DatasetFileInput } from "../domain/contracts.js";
import { warframePages, pageMedia } from "../collectors/official-media.js";
import { object, read } from "./identity.js";

/** Attach marketing media to exact frame/ability assets; keep gameplay icons as separate fields. */
export function enrichOfficialMedia(files: DatasetFileInput[], inputs: DatasetFileInput[]): DatasetFileInput[] {
  const index = inputs.find((file) => file.stage === "raw" && file.path === "official-site/warframes.html");
  if (!index) return files;
  const pages = warframePages(String(index.content));
  if (!pages.length) throw new Error("Unrecognized official warframe page index");
  const byIcon = new Map(pages.map((page) => [page.iconAsset, page]));
  const asset = (value: unknown) => typeof value === "string" ? value.match(/^https:\/\/content\.warframe\.com\/PublicExport(\/Lotus\/[^!]+)!/u)?.[1] : undefined;
  return files.map((file) => {
    if (file.path !== "catalog/equipment/warframes.json") return file;
    const root = read(file), isArray = Array.isArray(root);
    const rows = isArray ? Object.fromEntries(root.map((value, index) => [String(index), value])) : object(root);
    for (const [id, value] of Object.entries(rows)) {
      const frame = object(value), icon = String(frame.icon ?? asset(frame.iconUrl) ?? ""), page = byIcon.get(icon);
      if (!page) continue;
      const input = inputs.find((input) => input.path === `official-site/warframes/${page.pageUrl.split("/").pop()}.html`);
      if (!input) throw new Error(`Missing frozen official media page: ${page.pageUrl}`);
      const media = pageMedia(String(input.content));
      const { abilities, ...frameMedia } = media;
      if (Object.keys(frameMedia).length) frame.media = frameMedia;
      if (Array.isArray(frame.abilities)) frame.abilities = frame.abilities.map((raw) => {
        const ability = object(raw), image = abilities.find((entry) => entry.iconAsset === (ability.icon ?? asset(ability.abilityIconUrl) ?? asset(ability.iconUrl)));
        return image ? { ...ability, media: { showcaseImageUrl: image.imageUrl, ...(image.videoUrl ? { showcaseVideoUrl: image.videoUrl } : {}) } } : ability;
      });
      rows[id] = frame;
    }
    return { ...file, content: `${JSON.stringify(isArray ? Object.values(rows) : rows, null, 2)}\n` };
  });
}
