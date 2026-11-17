/**
 * The bike to show for a rider: their main garage bike (Profile tab, "My Bikes"),
 * or the bike saved on the profile itself (Edit profile and race registration).
 * The two are saved separately, so screens that read only one of them told riders
 * to "add your bike" when they already had.
 */
export interface BikeFields {
  bikeYear?: string | null;
  bikeManufacturer?: string | null;
  bikeModel?: string | null;
}

export function riderBike(
  profile: (BikeFields & { bikes?: Array<BikeFields & { isDefault?: boolean }> | null }) | null | undefined,
): BikeFields | null {
  if (!profile) return null;
  const named = (b: BikeFields | null | undefined) => !!(b && (b.bikeManufacturer || b.bikeModel || b.bikeYear));
  const garage = (profile.bikes ?? []).filter(named);
  const main = garage.find(b => b.isDefault) ?? garage[0];
  if (main) return main;
  return named(profile) ? profile : null;
}

/** "2024 KTM 250 SX-F", or "" when the rider has no bike on file. */
export function riderBikeLabel(profile: Parameters<typeof riderBike>[0]): string {
  const b = riderBike(profile);
  return b ? [b.bikeYear, b.bikeManufacturer, b.bikeModel].filter(Boolean).join(" ") : "";
}
