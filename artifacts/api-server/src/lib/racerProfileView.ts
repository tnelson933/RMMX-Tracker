/**
 * What a racer profile shows, for the signed-in pages (app and rider website)
 * and the public share page. One builder, so both show the same thing.
 *
 * Privacy (lib/riderResume.ts effectiveVisibility): results are public once a
 * race is finished. Bio, home state, photos, bike and sponsors show only on
 * public profiles or to the rider's own managers; riders under 18 start private.
 */
import { db, ridersTable, riderFollowsTable } from "@workspace/db";
import { count, eq, inArray } from "drizzle-orm";
import { loadRacerResume, loadResultsFeed, loadSeriesStandings } from "./riderCareer";
import { effectiveVisibility } from "./riderResume";
import { visiblePhotos } from "./riderPhotos";
import { bikeLabel, sponsorList } from "./riderProfilePlus";

const today = () => new Date().toISOString().slice(0, 10);

const RIDER_COLUMNS = {
  id: ridersTable.id, email: ridersTable.email, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
  bibNumber: ridersTable.bibNumber, homeState: ridersTable.homeState, dateOfBirth: ridersTable.dateOfBirth,
  bio: ridersTable.bio, plateColor: ridersTable.plateColor, profileVisibility: ridersTable.profileVisibility,
  avatarUrl: ridersTable.avatarUrl, coverUrl: ridersTable.coverUrl,
  bikeManufacturer: ridersTable.bikeManufacturer, bikeModel: ridersTable.bikeModel, bikeYear: ridersTable.bikeYear,
  sponsors: ridersTable.sponsors,
};

export async function loadProfileRider(riderId: number) {
  if (!Number.isInteger(riderId) || riderId <= 0) return null;
  const [rider] = await db.select(RIDER_COLUMNS).from(ridersTable).where(eq(ridersTable.id, riderId));
  return rider ?? null;
}
export type ProfileRider = NonNullable<Awaited<ReturnType<typeof loadProfileRider>>>;

/**
 * The profile as `isManager` (one of the rider's own accounts) or anyone else
 * sees it. Null when the rider has no results and the viewer isn't a manager.
 */
export async function buildRacerProfile(rider: ProfileRider, isManager: boolean) {
  const [{ stats, resume, extras }, recent, [followers], series] = await Promise.all([
    loadRacerResume(rider.id, true),
    loadResultsFeed([rider.id], 10),
    db.select({ n: count() }).from(riderFollowsTable).where(eq(riderFollowsTable.riderId, rider.id)),
    loadSeriesStandings(rider.id),
  ]);
  if (stats.starts === 0 && recent.length === 0 && !isManager) return null;
  const visibility = effectiveVisibility(rider, today());
  const showPersonal = visibility === "public" || isManager;
  return {
    riderId: rider.id,
    name: `${rider.firstName} ${rider.lastName}`.trim(),
    followerCount: Number(followers?.n ?? 0),
    stats,
    recent,
    resume,
    extras,
    series,
    profile: {
      number: rider.bibNumber ?? null,
      plateColor: rider.plateColor ?? null,
      state: showPersonal ? rider.homeState ?? null : null,
      bio: showPersonal ? rider.bio ?? null : null,
      bike: showPersonal ? bikeLabel({ year: rider.bikeYear, make: rider.bikeManufacturer, model: rider.bikeModel }) : null,
      sponsors: showPersonal ? sponsorList(rider.sponsors) : [],
      ...visiblePhotos(rider, isManager, today()),
    },
    visibility,
    isManager,
    /** The public page for this profile (only public profiles have one). */
    sharePath: visibility === "public" ? `/racer/${rider.id}` : null,
  };
}

/** Short rider cards (name, photo, number, class line) for lists; private riders are left out. */
export async function publicRiderCards(riderIds: number[]) {
  if (riderIds.length === 0) return new Map<number, { id: number; name: string; avatarUrl: string | null; number: string | null; state: string | null }>();
  const rows = await db.select({
    id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName, bibNumber: ridersTable.bibNumber,
    homeState: ridersTable.homeState, dateOfBirth: ridersTable.dateOfBirth, profileVisibility: ridersTable.profileVisibility,
    avatarUrl: ridersTable.avatarUrl,
  }).from(ridersTable).where(inArray(ridersTable.id, riderIds));
  const t = today();
  return new Map(rows.filter(r => effectiveVisibility(r, t) === "public").map(r => [r.id, {
    id: r.id, name: `${r.firstName} ${r.lastName}`.trim(), avatarUrl: r.avatarUrl ?? null,
    number: r.bibNumber ?? null, state: r.homeState ?? null,
  }]));
}
