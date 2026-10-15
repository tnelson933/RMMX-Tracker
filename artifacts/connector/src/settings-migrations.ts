export function migrateLegacyFeibotAddress(
  hardware: string | null,
  address: unknown,
): string {
  const value = typeof address === "string" ? address.trim() : "";
  if (hardware !== "active_transponder" && hardware !== "mylaps") return value;
  return value.replace(/:3333$/, ":55555");
}