export interface RegistrationTransponderRequirement {
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
  // Events don't pick a timing technology; the organizer turns this on when
  // their readers include an RM TrackR loop.
  if (!event.requireTransponder) return true;

  const hasPersonalTransponder = Boolean(selection.transponderNumber?.trim());
  const hasAvailableRental = Boolean(
    selection.rentTransponder && event.transponderRentalEnabled,
  );

  // A rider renting or buying one gets it from the organizer at check-in.
  return hasPersonalTransponder || hasAvailableRental || Boolean(selection.buyTransponder);
}