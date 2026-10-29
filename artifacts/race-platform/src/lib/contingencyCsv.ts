/**
 * The contingency report as a spreadsheet: one row per eligible finisher per
 * brand. Promoters email it to the brand or upload it to XTRM.
 */
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

export interface ContingencyReportData {
  eventId: number;
  eventName: string;
  eventDate: string;
  official: boolean;
  brands: Array<{ brand: string; finishers: ContingencyFinisher[] }>;
}

const HEADERS = [
  "Brand", "Event", "Event Date", "Results", "Class", "Position", "Riders in Class",
  "First Name", "Last Name", "AMA #", "Bib", "Bike Brand", "Bike Model", "Bike Year", "Runs Brand As",
];

/** Quote a cell; a leading = + - @ is neutralized so a spreadsheet never runs it as a formula. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** CSV for one brand, or every brand when `brand` is omitted. */
export function contingencyCsv(report: ContingencyReportData, brand?: string): string {
  const rows: string[] = [HEADERS.map(csvCell).join(",")];
  for (const b of report.brands) {
    if (brand !== undefined && b.brand !== brand) continue;
    for (const f of b.finishers) {
      rows.push([
        b.brand, report.eventName, report.eventDate, report.official ? "Official" : "Unofficial",
        f.raceClass, f.position, f.classSize, f.firstName, f.lastName, f.amaNumber, f.bibNumber,
        f.bikeBrand, f.bikeModel, f.bikeYear, f.matchedBy === "bike" ? "Bike" : "Sponsor",
      ].map(csvCell).join(","));
    }
  }
  return rows.join("\r\n") + "\r\n";
}

/** "Spring Classic", "Fox Racing" → "contingency-spring-classic-fox-racing.csv". */
export function contingencyFileName(eventName: string, brand?: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `contingency-${[slug(eventName) || "event", brand ? slug(brand) : "all-brands"].filter(Boolean).join("-")}.csv`;
}
