/**
 * Rocky Mountain ATV/MC Design System colours: red #B30000, charcoal #242424.
 * The brand red is only ~2.1:1 on charcoal, so on dark surfaces it is used for
 * fills (badges, buttons, stripes) and never for text: use `primaryText` for
 * accent text and icons, which is the red in light mode and white in dark mode.
 */
const colors = {
  light: {
    text: "#242424",
    tint: "#B30000",
    background: "#F4F4F2",
    foreground: "#242424",
    card: "#FFFFFF",
    cardForeground: "#242424",
    primary: "#B30000",
    primaryForeground: "#ffffff",
    /** Accent text and icons (the brand red is fine as text on light surfaces). */
    primaryText: "#B30000",
    secondary: "#38683D",
    secondaryForeground: "#ffffff",
    muted: "#ECECEA",
    mutedForeground: "#5E5E5C",
    accent: "#ECECEA",
    accentForeground: "#242424",
    destructive: "#C62828",
    destructiveForeground: "#ffffff",
    border: "#DEDEDC",
    input: "#DEDEDC",
    success: "#16a34a",
    successTint: "#dcfce7",
    warning: "#d97706",
    warningTint: "#fef3c7",
    dangerTint: "#fee2e2",
    primaryTint: "#F7E5E5",
    /** Charts: the rider's own line, the rest of the field, their best, a teammate. */
    chartYou: "#242424",
    chartField: "#A3A3A0",
    chartBest: "#B8860B",
    chartTeammate: "#2F6FD6",
    chartArea: "rgba(179,0,0,0.14)",
    chartGrid: "#E4E4E2",
  },
  // Race theme (matches the sign-in screen); the default appearance.
  dark: {
    text: "#FAFAFA",
    tint: "#B30000",
    background: "#161616",
    foreground: "#FAFAFA",
    card: "#242424",
    cardForeground: "#FAFAFA",
    primary: "#B30000",
    primaryForeground: "#ffffff",
    /** Accent text and icons: white, because the brand red can't be read on charcoal. */
    primaryText: "#FAFAFA",
    secondary: "#4a8a52",
    secondaryForeground: "#ffffff",
    muted: "#2E2E2E",
    mutedForeground: "#A8A8A8",
    accent: "#2E2E2E",
    accentForeground: "#FAFAFA",
    destructive: "#f03c3c",
    destructiveForeground: "#ffffff",
    border: "#3A3A3A",
    input: "#3A3A3A",
    success: "#22c55e",
    successTint: "rgba(34,197,94,0.15)",
    warning: "#f59e0b",
    warningTint: "rgba(245,158,11,0.15)",
    dangerTint: "rgba(239,68,68,0.15)",
    primaryTint: "rgba(179,0,0,0.22)",
    chartYou: "#FFFFFF",
    chartField: "#7A7A7A",
    chartBest: "#F5B700",
    chartTeammate: "#7FB2FF",
    chartArea: "rgba(179,0,0,0.35)",
    chartGrid: "#3A3A3A",
  },
  radius: 6,
};

export default colors;
