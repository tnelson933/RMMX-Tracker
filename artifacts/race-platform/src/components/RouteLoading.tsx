import { Component, Suspense, type ReactNode } from "react";
import { useLocation } from "wouter";
import { isChunkLoadError } from "@/lib/staleChunkReload";

/**
 * What shows while a page's code downloads. `variant` matches the surface the
 * page sits on, so nothing flashes or jumps when the page arrives:
 * - "inline": inside a layout (site header stays put), on the page background
 * - "screen": a full-screen page with no layout (live timing, watch, widgets),
 *   charcoal like the app's splash/theme colour
 * - "rider": the rider portal's dark race theme
 */
export type RouteLoadingVariant = "inline" | "screen" | "rider";

export function RouteLoading({ variant = "inline" }: { variant?: RouteLoadingVariant }) {
  const box =
    variant === "inline"
      ? "min-h-[60vh] bg-background text-muted-foreground"
      : variant === "rider"
        ? "rider-theme min-h-screen text-muted-foreground"
        : "min-h-screen bg-sidebar text-white/80";
  return (
    <div className={`flex items-center justify-center ${box}`} role="status" aria-live="polite">
      <span className="font-heading text-sm uppercase tracking-widest animate-pulse">Loading…</span>
    </div>
  );
}

type BoundaryProps = { children: ReactNode; variant?: RouteLoadingVariant };
type ErrorBoundaryProps = BoundaryProps & {
  /** The current address: moving to another page clears the error. */
  resetKey?: string;
};

/**
 * Catches a page that failed to load (no signal, or its code is gone after a
 * release and the one automatic reload didn't fix it) and offers a retry
 * instead of a blank screen.
 */
export class RouteErrorBoundary extends Component<ErrorBoundaryProps, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("[route] page failed to load", error);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    // The same boundary instance is reused when the router swaps pages.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const message = isChunkLoadError(this.state.error)
      ? offline
        ? "This page isn't saved on this device yet. Reconnect to the internet, then try again."
        : "This page didn't finish loading. Check your connection and try again."
      : "Something went wrong showing this page. Try again.";
    const variant = this.props.variant ?? "inline";
    const box =
      variant === "inline"
        ? "min-h-[60vh] bg-background text-foreground"
        : variant === "rider"
          ? "rider-theme min-h-screen text-foreground"
          : "min-h-screen bg-sidebar text-white";
    return (
      <div className={`flex flex-col items-center justify-center gap-4 px-6 text-center ${box}`} role="alert">
        <p className="max-w-sm">{message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-full bg-primary px-6 py-2 font-heading uppercase tracking-wider text-primary-foreground"
        >
          Try again
        </button>
      </div>
    );
  }
}

/** Suspense + error boundary for one lazily loaded page. */
export function RouteBoundary({ children, variant = "inline" }: BoundaryProps) {
  const [location] = useLocation();
  return (
    <RouteErrorBoundary variant={variant} resetKey={location}>
      <Suspense fallback={<RouteLoading variant={variant} />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}

/**
 * For extras around the pages (offline banner, desktop dialogs): loads them
 * lazily and, if their code can't be loaded, leaves them out instead of
 * taking the whole app down.
 */
export class OptionalLazy extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return null;
    return <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}
