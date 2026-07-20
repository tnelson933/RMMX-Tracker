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
    macArm:  `${base}/RM-Tracker-arm64.dmg`,
    macX64:  `${base}/RM-Tracker-x64.dmg`,
    windows: `${base}/RM-Tracker-Setup.exe`,
  };
}

interface ConnectorReleaseInfo {
  tag: string;
  macArm: string;
  macX64: string;
  windows: string;
  fetchedAt: number;
}

let connectorCache: ConnectorReleaseInfo | null = null;

function buildConnectorFromTag(tag: string): Omit<ConnectorReleaseInfo, "fetchedAt"> {
  const base = `https://github.com/tnelson933/RMMX-Tracker/releases/download/${tag}`;
  return {
    tag,
    macArm:  `${base}/RM-Connect-arm64.dmg`,
    macX64:  `${base}/RM-Connect-x64.dmg`,
    windows: `${base}/RM-Connect-Setup.exe`,
  };
}

router.get("/config/connector-release", async (_req, res) => {
  if (connectorCache && Date.now() - connectorCache.fetchedAt < CACHE_TTL_MS) {
    const { fetchedAt: _, ...data } = connectorCache;
    return res.json(data);
  }

  try {
    const r = await fetch(
      "https://api.github.com/repos/tnelson933/RMMX-Tracker/releases?per_page=30",
      { headers: { "User-Agent": "rmmx-server" } },
    );
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const releases = (await r.json()) as Array<{ tag_name: string; draft: boolean }>;
    const latest = releases.find((rel) => !rel.draft && rel.tag_name.startsWith("connector-v"));
    if (!latest) throw new Error("no connector release yet");
    const info = buildConnectorFromTag(latest.tag_name);
    connectorCache = { ...info, fetchedAt: Date.now() };
    return res.json(info);
  } catch {
    const info = buildConnectorFromTag("connector-v1.0.0");
    return res.json(info);
  }
});

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
    const info = buildFromTag("desktop-v1.0.62");
    return res.json(info);
  }
});

export default router;
