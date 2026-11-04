/**
 * Number-plate colours a rider can pick for their racer profile. Must match the
 * API's PLATE_COLORS (artifacts/api-server/src/lib/riderResume.ts). Shared by
 * the rider app and the rider website.
 */
export const PLATE_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  white: { bg: "#FFFFFF", fg: "#161616", border: "#B30000" },
  black: { bg: "#161616", fg: "#FFFFFF", border: "#FFFFFF" },
  red: { bg: "#B30000", fg: "#FFFFFF", border: "#161616" },
  yellow: { bg: "#F5C400", fg: "#161616", border: "#161616" },
  blue: { bg: "#1F5FD6", fg: "#FFFFFF", border: "#161616" },
  green: { bg: "#2E8B3E", fg: "#FFFFFF", border: "#161616" },
  orange: { bg: "#F26B1D", fg: "#161616", border: "#161616" },
};
export const PLATE_COLOR_NAMES = Object.keys(PLATE_COLORS);
export const BIO_MAX = 160;
