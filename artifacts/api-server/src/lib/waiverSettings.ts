import { db, clubSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/** The club's waiver fields: text typed in Forms, or an uploaded PDF. */
type WaiverSettings = {
  riderAcknowledgement?: string | null;
  waiverPdfUrl?: string | null;
  liabilityWaiverText?: string | null;
  liabilityWaiverPdfUrl?: string | null;
} | null | undefined;

const pdfSnapshot = (url: string | null | undefined) => (url?.trim() ? `[PDF waiver] ${url.trim()}` : null);

/**
 * What the rider signs, built on the server from the club's settings (never from the
 * request), so a stored signature always records the club's actual waiver.
 */
export function liabilityWaiverSnapshot(s: WaiverSettings): string | null {
  return s?.liabilityWaiverText?.trim() ? s.liabilityWaiverText : pdfSnapshot(s?.liabilityWaiverPdfUrl);
}

export function acknowledgementSnapshot(s: WaiverSettings): string | null {
  return s?.riderAcknowledgement?.trim() ? s.riderAcknowledgement : pdfSnapshot(s?.waiverPdfUrl);
}

/** The PDF's address when the snapshot is a PDF waiver (new "[PDF waiver] url" or older bare URL). */
export function waiverPdfOf(snapshot: string): string | null {
  const s = snapshot.trim();
  if (s.startsWith("[PDF waiver] ")) return s.slice("[PDF waiver] ".length).trim();
  if (/^(https?:\/\/|\/api\/storage\/)\S+$/.test(s)) return s;
  return null;
}

export async function clubWaiverSettings(clubId: number) {
  const [s] = await db.select({
    riderAcknowledgement: clubSettingsTable.riderAcknowledgement,
    waiverPdfUrl: clubSettingsTable.waiverPdfUrl,
    liabilityWaiverText: clubSettingsTable.liabilityWaiverText,
    liabilityWaiverPdfUrl: clubSettingsTable.liabilityWaiverPdfUrl,
    liabilityWaiverFields: clubSettingsTable.liabilityWaiverFields,
  }).from(clubSettingsTable).where(eq(clubSettingsTable.clubId, clubId));
  return s ?? null;
}

/**
 * Why an event can't require these forms yet (the club hasn't set them up), or null.
 * Requiring a form that doesn't exist would block every registration.
 */
export async function missingWaiverSetup(clubId: number, want: { requireWaiver?: unknown; requireLiabilityWaiver?: unknown }): Promise<string | null> {
  if (want.requireWaiver !== true && want.requireLiabilityWaiver !== true) return null;
  const s = await clubWaiverSettings(clubId);
  if (want.requireWaiver === true && !acknowledgementSnapshot(s)) {
    return "Add your rider acknowledgement form first (Team → Forms), then require it on the event.";
  }
  if (want.requireLiabilityWaiver === true && !liabilityWaiverSnapshot(s)) {
    return "Upload your liability waiver first (Team → Forms), then require it on the event.";
  }
  return null;
}
