/**
 * Download counts from GitHub Releases, which counts them for free.
 *
 * Each channel keeps a single release (the pipeline deletes the previous one when it publishes), so
 * what this reports is the downloads of each channel's current release, not an all-time total.
 */

const RELEASES = "https://api.github.com/repos/Tomas-Platero/PiCode/releases?per_page=20";

interface Release {
  tag_name: string;
  assets: { download_count: number }[];
}

export interface ChannelDownloads {
  tag: string;
  downloads: number;
}

/** `v0.2.7` is stable; `v0.2.7-beta` and `v0.2.7-experimental` name their channel. */
export function channelOfTag(tag: string): string {
  const suffix = /-([a-z]+)$/.exec(tag)?.[1];
  return suffix ?? "stable";
}

export function downloadsByChannel(releases: readonly Release[]): Record<string, ChannelDownloads> {
  const out: Record<string, ChannelDownloads> = {};
  for (const release of releases) {
    const channel = channelOfTag(release.tag_name);
    if (out[channel]) {
      continue; // the API lists newest first
    }
    const downloads = release.assets.reduce((sum, asset) => sum + asset.download_count, 0);
    out[channel] = { tag: release.tag_name, downloads };
  }
  return out;
}

/** Empty when GitHub does not answer: the usage half of the stats is still worth serving. */
export async function readDownloads(): Promise<Record<string, ChannelDownloads>> {
  try {
    const response = await fetch(RELEASES, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "picode-sync-api" },
      next: { revalidate: 3600 },
    });
    if (!response.ok) {
      console.error(`[picode-usage] GitHub releases answered ${response.status}`);
      return {};
    }
    return downloadsByChannel((await response.json()) as Release[]);
  } catch (error) {
    console.error("[picode-usage] could not read GitHub releases:", error);
    return {};
  }
}
