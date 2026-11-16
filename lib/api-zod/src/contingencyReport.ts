/**
 * Brand contingency: a brand (bike maker, or a gear/tire/fuel sponsor) pays
 * riders who finish well on its product. Promoters send each brand a list of
 * eligible finishers after the event (by upload to XTRM, or to the brand). This
 * matches riders to a brand by the bike brand and sponsors they entered at
 * registration; the brand applies its own rules (classes, places, model years).
 */

const ALIASES: Record<string, string> = {
  kawi: "kawasaki",
  husky: "husqvarna",
  husq: "husqvarna",
  gas: "gasgas",
  gasgasmotorcycles: "gasgas",
  yami: "yamaha",
  zuki: "suzuki",
};

/** "Gas Gas", "GASGAS", "gas-gas" → "gasgas"; known nicknames → the brand. */
export function normalizeBrand(value: string | null | undefined): string {
  const key = (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIASES[key] ?? key;
}

export interface RiderBrandInfo {
  bikeBrand: string | null | undefined;
  /** Free text, usually comma-separated ("KTM, FMF, Alpinestars"). */
  sponsors: string | null | undefined;
}

/** How a rider runs this brand: on their bike, as a listed sponsor, or not at all. */
export function riderBrandMatch(brand: string, rider: RiderBrandInfo): "bike" | "sponsor" | null {
  const wanted = normalizeBrand(brand);
  if (!wanted) return null;
  if (normalizeBrand(rider.bikeBrand) === wanted) return "bike";
  const sponsors = (rider.sponsors ?? "").split(/[,;/|\n]+/).map(normalizeBrand).filter(Boolean);
  if (sponsors.includes(wanted)) return "sponsor";
  return null;
}

export interface ContingencyFinisher {
  raceClass: string;
  position: number;
  classSize: number;
  riderId: number;
  firstName: string;
  lastName: string;
  bibNumber: string | null;
  amaNumber: string | null;
  bikeBrand: string | null;
  bikeModel: string | null;
  bikeYear: string | null;
  matchedBy: "bike" | "sponsor";
}

export interface ContingencyOverallClass {
  raceClass: string;
  riders: Array<{ position: number; riderId: number; bibNumber: string | null }>;
}

export interface ContingencyRiderDetails extends RiderBrandInfo {
  firstName: string;
  lastName: string;
  amaNumber: string | null;
  bikeModel: string | null;
  bikeYear: string | null;
}

/**
 * Each brand's finishers, in class order then position. Riders whose details
 * can't be found are skipped (they can't be matched to a brand).
 */
export function buildContingencyReport(
  brands: string[],
  classes: ContingencyOverallClass[],
  details: (riderId: number, raceClass: string) => ContingencyRiderDetails | null,
): Array<{ brand: string; finishers: ContingencyFinisher[] }> {
  const seen = new Set<string>();
  const uniqueBrands = brands.map(b => b.trim()).filter(b => {
    const key = normalizeBrand(b);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return uniqueBrands.map(brand => {
    const finishers: ContingencyFinisher[] = [];
    for (const cls of classes) {
      for (const r of cls.riders) {
        const d = details(r.riderId, cls.raceClass);
        if (!d) continue;
        const matchedBy = riderBrandMatch(brand, d);
        if (!matchedBy) continue;
        finishers.push({
          raceClass: cls.raceClass,
          position: r.position,
          classSize: cls.riders.length,
          riderId: r.riderId,
          firstName: d.firstName,
          lastName: d.lastName,
          bibNumber: r.bibNumber,
          amaNumber: d.amaNumber,
          bikeBrand: d.bikeBrand ?? null,
          bikeModel: d.bikeModel,
          bikeYear: d.bikeYear,
          matchedBy,
        });
      }
    }
    return { brand, finishers };
  });
}
