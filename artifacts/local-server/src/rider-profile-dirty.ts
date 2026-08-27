import type Database from "better-sqlite3";

export const RIDER_PROFILE_FIELDS = [
  ["firstName", "first_name"],
  ["lastName", "last_name"],
  ["email", "email"],
  ["phone", "phone"],
  ["dateOfBirth", "date_of_birth"],
  ["emergencyContact", "emergency_contact"],
  ["emergencyPhone", "emergency_phone"],
  ["rfidNumber", "rfid_number"],
  ["streetAddress", "street_address"],
  ["city", "city"],
  ["homeState", "home_state"],
  ["zip", "zip"],
  ["bibNumber", "bib_number"],
  ["amaNumber", "ama_number"],
  ["bikeManufacturer", "bike_manufacturer"],
  ["bikeModel", "bike_model"],
  ["bikeYear", "bike_year"],
  ["sponsors", "sponsors"],
  ["mylapsTransponderId", "mylaps_transponder_id"],
] as const;

const apiFieldForColumn = new Map<string, string>(
  RIDER_PROFILE_FIELDS.map(([apiField, column]) => [column, apiField]),
);

/**
 * Records profile intent separately from the riders cache. Repeated edits bump
 * the version so an acknowledgement can only clear the exact write it sent.
 */
export function markRiderFieldsDirty(
  db: Database.Database,
  riderId: number,
  fields: Iterable<string>,
): void {
  const mark = db.prepare(`
    INSERT INTO _rider_profile_dirty (rider_id, field_name, version, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(rider_id, field_name) DO UPDATE SET
      version = version + 1,
      updated_at = datetime('now')
  `);
  const ensureIdentity = db.prepare(`
    INSERT OR IGNORE INTO _rider_cloud_map (local_rider_id, client_identity)
    VALUES (?, lower(hex(randomblob(16))))
  `);

  ensureIdentity.run(riderId);
  for (const field of fields) {
    const apiField = apiFieldForColumn.get(field) ?? field;
    if (RIDER_PROFILE_FIELDS.some(([candidate]) => candidate === apiField)) {
      mark.run(riderId, apiField);
    }
  }
}

export function markNewRiderDirty(db: Database.Database, riderId: number): void {
  markRiderFieldsDirty(
    db,
    riderId,
    RIDER_PROFILE_FIELDS.map(([apiField]) => apiField),
  );
}