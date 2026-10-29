import { db, eventPublicationTable, motosTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";

/**
 * Results are public as soon as a moto finishes, labelled "Unofficial
 * results". The organizer reviews each finished moto on Race Day Management
 * and clicks Finalize Race: from then on its results are "Official results".
 *
 * The event's publication row now means "all results official": every
 * finished moto finalized. It's kept in step here.
 */

/** SQL condition: this moto's results are official. Use with a join to motosTable. */
export const motoFinalized = isNotNull(motosTable.resultsFinalizedAt);

/**
 * Sets the event's publication row ("all official") from its motos. Returns
 * true when the event just became fully official, for follower notifications.
 */
export async function syncEventPublication(eventId: number): Promise<boolean> {
  // Practice sessions aren't finalized, so they never hold an event back.
  const finished = await db.select({ id: motosTable.id, finalizedAt: motosTable.resultsFinalizedAt })
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"), ne(motosTable.type, "practice")));
  const official = finished.length > 0 && finished.every(m => m.finalizedAt != null);
  const [existing] = await db.select().from(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId));
  if (existing) {
    if (existing.published !== official) {
      await db.update(eventPublicationTable).set({
        published: official,
        publishedAt: official ? new Date() : null,
        updatedAt: new Date(),
      }).where(eq(eventPublicationTable.eventId, eventId));
    }
  } else if (official) {
    await db.insert(eventPublicationTable).values({ eventId, published: true, publishedAt: new Date() });
  }
  return official && !existing?.published;
}

/** Finished motos of an event that still need finalizing. */
export async function unofficialMotoIds(eventId: number): Promise<number[]> {
  const rows = await db.select({ id: motosTable.id }).from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"), ne(motosTable.type, "practice"), isNull(motosTable.resultsFinalizedAt)));
  return rows.map(r => r.id);
}
