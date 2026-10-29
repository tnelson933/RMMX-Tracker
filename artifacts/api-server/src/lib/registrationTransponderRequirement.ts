export interface RegistrationTransponderRequirement {
  timingTechnology: string | null | undefined;
  requireTransponder: boolean | null | undefined;
  transponderRentalEnabled: boolean | null | undefined;
}

export interface RegistrationTransponderSelection {
  transponderNumber: string | null | undefined;
  rentTransponder: boolean | null | undefined;
  /** Buying an RM TrackR the event offers (already checked against its purchase options). */
  buyTransponder?: boolean | null;
}

export function isRegistrationTransponderRequirementSatisfied(
  event: RegistrationTransponderRequirement,
  selection: RegistrationTransponderSelection,
): boolean {
  const usesActiveTiming = event.timingTechnology === "active_transponder";

  if (!usesActiveTiming || !event.requireTransponder) return true;

  const hasPersonalTransponder = Boolean(selection.transponderNumber?.trim());
  const hasAvailableRental = Boolean(
    selection.rentTransponder && event.transponderRentalEnabled,
  );

  // A rider renting or buying one gets it from the organizer at check-in.
  return hasPersonalTransponder || hasAvailableRental || Boolean(selection.buyTransponder);
}