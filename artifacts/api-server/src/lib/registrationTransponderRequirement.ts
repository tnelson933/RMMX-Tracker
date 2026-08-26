export interface RegistrationTransponderRequirement {
  timingTechnology: string | null | undefined;
  requireTransponder: boolean | null | undefined;
  transponderRentalEnabled: boolean | null | undefined;
}

export interface RegistrationTransponderSelection {
  transponderNumber: string | null | undefined;
  rentTransponder: boolean | null | undefined;
}

export function isRegistrationTransponderRequirementSatisfied(
  event: RegistrationTransponderRequirement,
  selection: RegistrationTransponderSelection,
): boolean {
  const usesActiveTiming =
    event.timingTechnology === "active_transponder" ||
    event.timingTechnology === "mylaps";

  if (!usesActiveTiming || !event.requireTransponder) return true;

  const hasPersonalTransponder = Boolean(selection.transponderNumber?.trim());
  const hasAvailableRental = Boolean(
    selection.rentTransponder && event.transponderRentalEnabled,
  );

  return hasPersonalTransponder || hasAvailableRental;
}