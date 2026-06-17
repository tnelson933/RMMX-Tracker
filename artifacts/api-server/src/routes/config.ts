import { Router } from "express";

const router = Router();

interface ReleaseInfo {
  tag: string;
  macArm: string;
  macX64: string;
  windows: string;
  fetchedAt: number;
}

let cache: ReleaseInfo | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function buildFromTag(tag: string): Omit<ReleaseInfo, "fetchedAt"> {
  const base = `https://github.com/tnelson933/RMMX-Tracker/releases/download/${tag}`;
  return {
    tag,
    macArm:  `${base}/RMMX-Tracker-arm64.dmg`,
    macX64:  `${base}/RMMX-Tracker-x64.dmg`,
    windows: `${base}/RMMX-Tracker-Setup.exe`,
  };
}

router.get("/config/desktop-release", async (_req, res) => {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    const { fetchedAt: _, ...data } = cache;
    return res.json(data);
  }

  try {
    const r = await fetch(
      "https://api.github.com/repos/tnelson933/RMMX-Tracker/releases/latest",
      { headers: { "User-Agent": "rmmx-server" } },
    );
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const json = (await r.json()) as { tag_name: string };
    const info = buildFromTag(json.tag_name);
    cache = { ...info, fetchedAt: Date.now() };
    return res.json(info);
  } catch {
    const info = buildFromTag("desktop-v1.0.57");
    return res.json(info);
  }
});

export default router;
