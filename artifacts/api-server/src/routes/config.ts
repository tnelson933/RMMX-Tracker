import { Router } from "express";

const router = Router();

const REPO = "tnelson933/RMMX-Tracker";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface ReleaseLinks {
  tag: string;
  macArm: string;
  macX64: string;
  windows: string;
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

/**
 * Download links for the newest published release whose tag starts with
 * `prefix` ("desktop-v" / "connector-v"). Links come from the release's own
 * assets, so installer renames (RM-Tracker → RM-Roost) don't break them.
 * The repo holds both apps, so GitHub's single "latest" release can't be used.
 */
function releaseEndpoint(prefix: string, fallbackTag: string, fallbackStem: string) {
  let cache: (ReleaseLinks & { fetchedAt: number }) | null = null;

  const fromNames = (tag: string, stem: string): ReleaseLinks => {
    const base = `https://github.com/${REPO}/releases/download/${tag}`;
    return { tag, macArm: `${base}/${stem}-arm64.dmg`, macX64: `${base}/${stem}-x64.dmg`, windows: `${base}/${stem}-Setup.exe` };
  };

  return async (_req: any, res: any) => {
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      const { fetchedAt: _, ...data } = cache;
      return res.json(data);
    }
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
        headers: { "User-Agent": "rm-roost-server", Accept: "application/vnd.github+json" },
      });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const releases = (await r.json()) as GithubRelease[];
      const latest = releases.find(rel => !rel.draft && !rel.prerelease && rel.tag_name.startsWith(prefix));
      if (!latest) throw new Error(`no ${prefix} release`);
      const find = (test: (n: string) => boolean) => latest.assets.find(a => test(a.name))?.browser_download_url;
      const named = fromNames(latest.tag_name, fallbackStem);
      const links: ReleaseLinks = {
        tag: latest.tag_name,
        macArm: find(n => n.endsWith(".dmg") && n.includes("arm64")) ?? named.macArm,
        macX64: find(n => n.endsWith(".dmg") && n.includes("x64")) ?? named.macX64,
        windows: find(n => n.endsWith(".exe")) ?? named.windows,
      };
      cache = { ...links, fetchedAt: Date.now() };
      return res.json(links);
    } catch {
      return res.json(fromNames(fallbackTag, fallbackStem));
    }
  };
}

router.get("/config/connector-release", releaseEndpoint("connector-v", "connector-v1.0.17", "RM-Connect"));
router.get("/config/desktop-release", releaseEndpoint("desktop-v", "desktop-v1.0.113", "RM-Roost"));

export default router;
