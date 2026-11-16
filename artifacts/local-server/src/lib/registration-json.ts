// A registration row as the website's API returns it from POST
// /events/:id/registrations and PATCH /registrations/:id (the saved row).
import { parseBool, parseJsonArr } from "../db";
import { isoTime } from "./cloud-shape";

export function registrationJson(r: Record<string, any>) {
  return {
    id: r.id,
    eventId: r.event_id,
    riderId: r.rider_id,
    raceClass: r.race_class,
    status: r.status,
    paymentStatus: r.payment_status ?? "unpaid",
    paymentMethod: r.payment_method ?? null,
    amountPaid: r.amount_paid ?? null,
    cashTendered: r.cash_tendered ?? null,
    cashChange: r.cash_change ?? null,
    amountDue: r.amount_due ?? null,
    stripeSessionId: r.stripe_session_id ?? null,
    bibNumber: r.bib_number ?? null,
    amaNumber: r.ama_number ?? null,
    clubIdNumber: r.club_id_number ?? null,
    bikeBrand: r.bike_brand ?? null,
    bikeModel: r.bike_model ?? null,
    bikeYear: r.bike_year ?? null,
    sponsors: r.sponsors ?? null,
    statsEmailOptIn: parseBool(r.stats_email_opt_in),
    transponderRental: parseBool(r.transponder_rental),
    myLapsTransponderNumber: r.mylaps_transponder_number ?? null,
    selectedPurchaseOptions: parseJsonArr(r.selected_purchase_options),
    compCode: r.comp_code ?? null,
    compDiscount: r.comp_discount ?? null,
    displayFirstName: r.display_first_name ?? null,
    displayLastName: r.display_last_name ?? null,
    teamName: r.team_name ?? null,
    rfidStickerPurchased: parseBool(r.rfid_sticker_purchased),
    rmTrackrPurchased: parseBool(r.rm_trackr_purchased),
    rmTrackrFulfilledAt: r.rm_trackr_fulfilled_at ?? null,
    rmTrackrTransponder: r.rm_trackr_transponder ?? null,
    transponderReturned: parseBool(r.transponder_returned),
    rentalReminderStatus: r.rental_reminder_status ?? null,
    rentalReminderAt: r.rental_reminder_at ?? null,
    waiverAcknowledgedAt: r.waiver_acknowledged_at ?? null,
    waiverSnapshot: r.waiver_snapshot ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancellationSource: r.cancellation_source ?? null,
    refundVerifiedAt: r.refund_verified_at ?? null,
    createdAt: isoTime(r.created_at),
  };
}

type PurchaseOption = { id: string; name: string; amount: number };

/**
 * The purchase options a rider picked, taken from the event's own list (so the
 * name and price are the event's, not the request's). Same rule as the cloud's
 * lib/purchaseOptions.ts.
 */
export function resolvePurchaseOptions(submitted: unknown, configured: unknown): PurchaseOption[] {
  if (!Array.isArray(submitted) || !Array.isArray(configured)) return [];
  const byId = new Map((configured as PurchaseOption[]).map(o => [String(o.id), o]));
  const seen = new Set<string>();
  const out: PurchaseOption[] = [];
  for (const item of submitted) {
    const id = typeof item === "string" || typeof item === "number"
      ? String(item)
      : item && typeof item === "object" && "id" in item ? String((item as { id: unknown }).id) : null;
    if (id == null || seen.has(id)) continue;
    const option = byId.get(id);
    if (!option) continue;
    const amount = Number(option.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    seen.add(id);
    out.push({ ...option, amount });
  }
  return out;
}
