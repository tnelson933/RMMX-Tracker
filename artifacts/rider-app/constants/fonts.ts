/**
 * Brand type (Rocky Mountain ATV/MC Design System): Barlow for display text
 * (titles, uppercase labels, positions and big numbers), Roboto for body text.
 * Loaded in app/_layout.tsx. Italic display uses its own face, because Android
 * can't synthesize italics for custom fonts.
 */
export const fonts = {
  regular: "Roboto_400Regular",
  medium: "Roboto_500Medium",
  semibold: "Roboto_600SemiBold",
  bold: "Roboto_700Bold",
  display: "Barlow_700Bold",
  displayHeavy: "Barlow_800ExtraBold",
  displayItalic: "Barlow_800ExtraBold_Italic",
} as const;
