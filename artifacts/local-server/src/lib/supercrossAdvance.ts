// Supercross: the top finishers of a class's heats go to its Main Event
// (the website's autoAdvanceToMain / advance-to-main in api-server
// routes/motos.ts). Keep the two in step.
import { getDb, parseJsonArr } from "../db";

type LineupEntry = { position: number; riderId: number; riderName: string; bibNumber: string | null; rfidNumber: string | null };

/** The Main Event lineup from the class's heats: each heat's top finishers, in heat order. */
export function mainLineupFromHeats(eventId: number, raceClass: string, topPerHeat: number): { mainMotoId: number; lineup: LineupEntry[] } | { error: "no_heats" | "no_main" } {
  const db = getDb();
  const heatMotos = db.prepare("SELECT * FROM motos WHERE event_id = ? AND race_class = ? AND type = 'heat'").all(eventId, raceClass) as any[];
  if (heatMotos.length === 0) return { error: "no_heats" };
  const mainMoto = db.prepare("SELECT * FROM motos WHERE event_id = ? AND race_class = ? AND type = 'main' LIMIT 1").get(eventId, raceClass) as any;
  if (!mainMoto) return { error: "no_main" };

  const resultsFor = db.prepare("SELECT * FROM race_results WHERE moto_id = ?");
  const advanced = new Set<number>();
  const lineup: LineupEntry[] = [];
  for (const heat of heatMotos) {
    const results = resultsFor.all(heat.id) as any[];
    const heatLineup = parseJsonArr<LineupEntry>(heat.lineup);
    if (results.length > 0) {
      const sorted = results.filter((r) => r.dnf !== 1 && r.dns !== 1).sort((a, b) => a.position - b.position);
      for (const r of sorted.slice(0, topPerHeat)) {
        if (advanced.has(r.rider_id)) continue;
        advanced.add(r.rider_id);
        const fromLineup = heatLineup.find((l) => l.riderId === r.rider_id);
        lineup.push({
          position: lineup.length + 1,
          riderId: r.rider_id,
          riderName: fromLineup?.riderName ?? `Rider #${r.rider_id}`,
          bibNumber: r.bib_number ?? fromLineup?.bibNumber ?? null,
          rfidNumber: fromLineup?.rfidNumber ?? null,
        });
      }
    } else {
      const sorted = [...heatLineup].sort((a, b) => a.position - b.position);
      for (const l of sorted.slice(0, topPerHeat)) {
        if (advanced.has(l.riderId)) continue;
        advanced.add(l.riderId);
        lineup.push({ position: lineup.length + 1, riderId: l.riderId, riderName: l.riderName, bibNumber: l.bibNumber ?? null, rfidNumber: l.rfidNumber ?? null });
      }
    }
  }
  lineup.forEach((r, i) => { r.position = i + 1; });
  return { mainMotoId: mainMoto.id, lineup };
}

/**
 * A heat just finished: on a Supercross (Main Event Only) table, once every
 * heat of the class is finished, fill the Main Event with the top 30% of the
 * average heat (at least 1 per heat), as the website does by itself.
 */
export function autoAdvanceAfterHeat(motoId: number): void {
  try {
    const db = getDb();
    const moto = db.prepare("SELECT id, event_id, race_class, type FROM motos WHERE id = ?").get(motoId) as any;
    if (!moto || moto.type !== "heat") return;
    const table = db.prepare(
      "SELECT pt.main_event_only FROM events e JOIN points_tables pt ON pt.id = e.scoring_table_id WHERE e.id = ?",
    ).get(moto.event_id) as { main_event_only: number } | undefined;
    if (table?.main_event_only !== 1) return;
    const heats = db.prepare("SELECT status, lineup FROM motos WHERE event_id = ? AND race_class = ? AND type = 'heat'").all(moto.event_id, moto.race_class) as any[];
    if (!heats.every((h) => h.status === "completed")) return;
    const totalRiders = heats.reduce((sum, h) => sum + parseJsonArr(h.lineup).length, 0);
    const topPerHeat = Math.max(1, Math.round((heats.length > 0 ? totalRiders / heats.length : 0) * 0.3));
    const built = mainLineupFromHeats(moto.event_id, moto.race_class, topPerHeat);
    if ("error" in built) return;
    db.prepare("UPDATE motos SET lineup = ? WHERE id = ?").run(JSON.stringify(built.lineup), built.mainMotoId);
  } catch (err) {
    console.warn(`[motos] could not advance heat ${motoId} to the main:`, err instanceof Error ? err.message : err);
  }
}
