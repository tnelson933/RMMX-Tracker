import type Database from "better-sqlite3";
import { markNewRiderDirty, markRiderFieldsDirty } from "./rider-profile-dirty";

type RiderResolution =
  | { riderId: number; rider: Record<string, unknown> }
  | { status: number; error: string };

const profileFields: Array<[string, string]> = [
  ["firstName", "first_name"],
  ["lastName", "last_name"],
  ["email", "email"],
  ["phone", "phone"],
  ["dateOfBirth", "date_of_birth"],
  ["emergencyContact", "emergency_contact"],
  ["emergencyPhone", "emergency_phone"],
  ["streetAddress", "street_address"],
  ["city", "city"],
  ["homeState", "home_state"],
  ["zip", "zip"],
  ["bibNumber", "bib_number"],
  ["bikeBrand", "bike_manufacturer"],
  ["bikeModel", "bike_model"],
  ["bikeYear", "bike_year"],
  ["sponsors", "sponsors"],
  ["amaNumber", "ama_number"],
];

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function profileValue(value: unknown): unknown {
  return typeof value === "string" ? value.trim() || null : value ?? null;
}

/**
 * Resolve the rider identity used by a registration and apply only profile
 * fields that were actually supplied by the caller.
 */
export function resolveRegistrationRider(
  db: Database.Database,
  body: Record<string, unknown>,
): RiderResolution {
  const email = normalized(body.email);
  if (
    (body.firstName !== undefined && !normalized(body.firstName)) ||
    (body.lastName !== undefined && !normalized(body.lastName))
  ) {
    return { status: 400, error: "firstName and lastName cannot be blank" };
  }
  const explicitId = body.riderId;
  let rider: Record<string, unknown> | undefined;

  if (explicitId !== undefined && explicitId !== null && explicitId !== "") {
    const riderId = Number(explicitId);
    if (!Number.isInteger(riderId) || riderId <= 0) {
      return { status: 400, error: "riderId must be a positive integer" };
    }
    if (!email) {
      return { status: 400, error: "email is required when riderId is supplied" };
    }
    rider = db.prepare("SELECT * FROM riders WHERE id = ?").get(riderId) as
      | Record<string, unknown>
      | undefined;
    if (!rider) return { status: 404, error: "Rider profile not found" };
    if (normalized(rider.email) !== email) {
      return {
        status: 409,
        error: "The selected rider profile does not match the supplied email",
      };
    }
  } else {
    if (!email) return { status: 400, error: "email is required" };
    const emailMatches = db
      .prepare("SELECT * FROM riders WHERE lower(trim(email)) = ? ORDER BY id ASC")
      .all(email) as Record<string, unknown>[];

    if (emailMatches.length === 1) {
      rider = emailMatches[0];
    } else if (emailMatches.length > 1) {
      return {
        status: 409,
        error:
          "profile-selection-required: Multiple rider profiles use this email. Select the correct rider profile before registering.",
      };
    }
  }

  if (!rider) {
    const firstName = normalized(body.firstName);
    const lastName = normalized(body.lastName);
    if (!firstName || !lastName) {
      return {
        status: 400,
        error: "firstName and lastName are required",
      };
    }
    const columns: string[] = [];
    const placeholders: string[] = [];
    const values: unknown[] = [];
    for (const [apiField, column] of profileFields) {
      if (body[apiField] !== undefined) {
        columns.push(column);
        placeholders.push("?");
        values.push(profileValue(body[apiField]));
      }
    }
    columns.push("created_at");
    placeholders.push("datetime('now')");
    const created = db
      .prepare(
        `INSERT INTO riders (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      )
      .run(...(values as any[]));
    rider = db
      .prepare("SELECT * FROM riders WHERE id = ?")
      .get(Number(created.lastInsertRowid)) as Record<string, unknown>;
    markNewRiderDirty(db, Number(created.lastInsertRowid));
  } else {
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const [apiField, column] of profileFields) {
      if (body[apiField] !== undefined) {
        updates.push(`${column} = ?`);
        values.push(profileValue(body[apiField]));
      }
    }
    if (updates.length) {
      values.push(rider.id);
      db.prepare(`UPDATE riders SET ${updates.join(", ")} WHERE id = ?`).run(
        ...(values as any[]),
      );
      markRiderFieldsDirty(db, Number(rider.id), updates.map((update) => update.split(" ")[0]));
      rider = db.prepare("SELECT * FROM riders WHERE id = ?").get(rider.id) as Record<
        string,
        unknown
      >;
    }
  }

  return { riderId: Number(rider.id), rider };
}