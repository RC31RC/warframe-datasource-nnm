import { createHash } from "node:crypto";
import { fetchBytes } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

export const WARFRAMES_URL = "https://www.warframe.com/en/game/warframes";
export type WarframePage = { name: string; pageUrl: string; iconAsset: string; variant: string };
const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/gu)].map((match) => [match[1], match[2]]));

/** The list supplies the exact game icon asset, so the join does not guess a frame by its slug. */
export function warframePages(html: string): WarframePage[] {
  return [...html.matchAll(/<a\b([^>]*\bclass="[^"]*WarframeListTile[^>]+)>([\s\S]*?)<\/a>/gu)].flatMap((match) => {
    const attr = attributes(match[1]!), body = match[2]!, image = /<img\b[^>]+>/u.exec(body);
    if (!image || attr["data-type"] === "proto") return [];
    const src = attributes(image[0]).src ?? "";
    const iconAsset = src.match(/^https:\/\/content\.warframe\.com\/PublicExport(\/Lotus\/[^!]+)!/u)?.[1];
    const pageUrl = attr.href;
    if (!iconAsset || !pageUrl?.startsWith(`${WARFRAMES_URL}/`)) return [];
    return [{ name: attr["data-id"] ?? "", pageUrl, iconAsset, variant: attr["data-type"] ?? "" }];
  });
}

export function pageMedia(html: string): { splashImageUrl?: string; dioramaVideoUrl?: string; abilities: { iconAsset: string; imageUrl: string; videoUrl?: string }[] } {
  const videos = [...html.matchAll(/<video\b([^>]*\bclass="[^"]*MastheadBackgroundVideo[^>]+)>([\s\S]*?)<\/video>/gu)];
  const video = videos.find((match) => /\bis-active\b/u.test(match[1]!)) ?? (videos.length === 1 ? videos[0] : undefined);
  const poster = video ? attributes(video[1]!).poster : undefined;
  const source = video ? /<source\b[^>]+>/u.exec(video[2]!) : undefined;
  const videoUrl = source ? attributes(source[0]).src : undefined;
  const official = (value: string | undefined) => value?.startsWith("https://www-static.warframe.com/") ? value : undefined;
  const splash = official(poster), diorama = official(videoUrl);
  const abilities: { iconAsset: string; imageUrl: string; videoUrl?: string }[] = [...html.matchAll(/<img\b[^>]*class="WarframeAbilityCard-image"[^>]+>[\s\S]*?<img\b[^>]*class="WarframeAbilityCard-icon"[^>]+>/gu)].flatMap((match) => {
    const images = [...match[0].matchAll(/<img\b[^>]+>/gu)].map((tag) => attributes(tag[0]).src ?? "");
    const iconAsset = images[1]?.match(/^https:\/\/content\.warframe\.com\/PublicExport(\/Lotus\/[^!]+)!/u)?.[1];
    const imageUrl = official(images[0]);
    return iconAsset && imageUrl ? [{ iconAsset, imageUrl }] : [];
  });
  // Newer pages render four icon tabs and four matching video panels in the same order.
  const gridIcons = /<div\b[^>]*class="WarframeAbilityGrid-icons"[^>]*>([\s\S]*?)<\/div>/u.exec(html)?.[1] ?? "";
  const gridVideos = /<div\b[^>]*class="WarframeAbilityGrid-videos"[^>]*>([\s\S]*?)<\/div>/u.exec(html)?.[1] ?? "";
  const icons = [...gridIcons.matchAll(/<img\b[^>]*class="WarframeAbilityIcon[^>]+>/gu)].map((match) => attributes(match[0]).src?.match(/^https:\/\/content\.warframe\.com\/PublicExport(\/Lotus\/[^!]+)!/u)?.[1]);
  const panels = [...gridVideos.matchAll(/<video\b([^>]*class="WarframeAbilityVideo[^>]+)>([\s\S]*?)<\/video>/gu)];
  if (icons.length && icons.length === panels.length) {
    panels.forEach((panel, index) => {
      const imageUrl = official(attributes(panel[1]!).poster), iconAsset = icons[index];
      const videoSource = [...panel[2]!.matchAll(/<source\b[^>]+>/gu)].map((match) => attributes(match[0])).find((attr) => attr.type === "video/webm");
      const videoUrl = official(videoSource?.src);
      if (iconAsset && imageUrl) abilities.push({ iconAsset, imageUrl, ...(videoUrl ? { videoUrl } : {}) });
    });
  }
  return { ...(splash ? { splashImageUrl: splash } : {}), ...(diorama ? { dioramaVideoUrl: diorama } : {}), abilities };
}

export async function collectOfficialMedia(now = new Date()): Promise<DatasetFileInput[]> {
  const capture = async (url: string, path: string): Promise<DatasetFileInput> => {
    const content = await fetchBytes(url, { timeoutMs: 30000, maxBytes: 4 * 1024 * 1024, retries: 3 });
    return { stage: "raw", path, content, source: { project: "Warframe", url, dataset: path,
      capturedAt: now.toISOString(), upstreamRevision: createHash("sha256").update(content).digest("hex"), transformer: "warframe-datasource-nnm/official-media@1" } };
  };
  const index = await capture(WARFRAMES_URL, "official-site/warframes.html");
  const pages = warframePages(String(index.content));
  if (!pages.length) throw new Error("Official warframe list contains no recognized game-asset links");
  const urls = [...new Set(pages.map((page) => page.pageUrl))];
  const files: DatasetFileInput[] = [];
  // Bound website load; result order follows the index, not request completion order.
  for (let offset = 0; offset < urls.length; offset += 6) {
    const batch = await Promise.all(urls.slice(offset, offset + 6).map((url) => capture(url, `official-site/warframes/${url.split("/").pop()}.html`)));
    files.push(...batch);
  }
  return [index, ...files];
}
