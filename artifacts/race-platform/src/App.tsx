import { Suspense, lazy, useEffect } from "react";
import { useRouteTitle } from "@/hooks/useDocumentTitle";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { RiderAuthProvider, useRiderAuth } from "@/contexts/RiderAuthContext";
import { BroadcastProvider } from "@/contexts/BroadcastContext";
import { PublicLayout } from "@/components/layout/PublicLayout";
import NotFound from "@/pages/not-found";
import { OptionalLazy, RouteBoundary, RouteErrorBoundary, RouteLoading } from "@/components/RouteLoading";
import { lazyPage, preloadWhenIdle } from "@/lib/lazyPage";

// Pages download on demand: a spectator opening the home page or a live
// leaderboard doesn't download the organizer portal. Home stays in the main
// bundle because it's the most common way in.
import Home from "@/pages/public/Home";

// ── Spectator pages (preloaded while idle on the home page) ──
const Results = lazyPage(() => import("@/pages/public/Results"));
const EventResults = lazyPage(() => import("@/pages/public/EventResults"));
const LiveLeaderboard = lazyPage(() => import("@/pages/public/LiveLeaderboard"));
const WatchLive = lazyPage(() => import("@/pages/public/WatchLive"));
const Leaderboard = lazyPage(() => import("@/pages/public/Leaderboard"));
const PublicRacer = lazyPage(() => import("@/pages/public/PublicRacer"));

// ── Other public pages ──
const RiderAppLanding = lazyPage(() => import("@/pages/public/RiderAppLanding"));
const PhoneLive = lazyPage(() => import("@/pages/public/PhoneLive"));
const RiderLiveWatch = lazyPage(() => import("@/pages/public/RiderLiveWatch"));
const Login = lazyPage(() => import("@/pages/public/Login"));
const ForgotPassword = lazyPage(() => import("@/pages/public/ForgotPassword"));
const Register = lazyPage(() => import("@/pages/public/Register"));
const PdfView = lazyPage(() => import("@/pages/public/PdfView"));
const SetPassword = lazyPage(() => import("@/pages/public/SetPassword"));
const SupportDecision = lazyPage(() => import("@/pages/public/SupportDecision"));
const HandScanner = lazyPage(() => import("@/pages/public/HandScanner"));
const EventWidget = lazyPage(() => import("@/pages/public/EventWidget"));
const SeriesWidget = lazyPage(() => import("@/pages/public/SeriesWidget"));
const PrivacyPolicy = lazyPage(() => import("@/pages/public/PrivacyPolicy"));
const TermsAndConditions = lazyPage(() => import("@/pages/public/TermsAndConditions"));
const DeleteAccount = lazyPage(() => import("@/pages/public/DeleteAccount"));
const GateSchedulePage = lazyPage(() => import("@/pages/organizer/GateSchedulePage"));
const MobileGateSchedulePage = lazyPage(() => import("@/pages/organizer/MobileGateSchedulePage"));

// ── Rider portal ──
const RiderLogin = lazyPage(() => import("@/pages/rider/RiderLogin"));
const ResetRiderPassword = lazyPage(() => import("@/pages/rider/ResetRiderPassword"));
const RiderPortal = lazyPage(() => import("@/pages/rider/RiderPortal"));
const RiderHistory = lazyPage(() => import("@/pages/rider/RiderHistory"));
const RiderCreateProfile = lazyPage(() => import("@/pages/rider/RiderCreateProfile"));
const RmCash = lazyPage(() => import("@/pages/rider/RmCash"));
const RacerProfile = lazyPage(() => import("@/pages/rider/RacerProfile"));
const RiderFollowing = lazyPage(() => import("@/pages/rider/RiderFollowing"));
const RiderHome = lazyPage(() => import("@/pages/rider/RiderHome"));
const RiderRaces = lazyPage(() => import("@/pages/rider/RiderRaces"));
const RiderResults = lazyPage(() => import("@/pages/rider/RiderResults"));
const RiderTrain = lazyPage(() => import("@/pages/rider/RiderTrain"));
const RiderMechanic = lazyPage(() => import("@/pages/rider/RiderMechanic"));

// ── Organizer portal (preloaded while idle once signed in, for offline use) ──
const Dashboard = lazyPage(() => import("@/pages/organizer/Dashboard"));
const EventLayout = lazyPage(() => import("@/pages/organizer/EventLayout"));
const EventsList = lazyPage(() => import("@/pages/organizer/EventsList"));
const Riders = lazyPage(() => import("@/pages/organizer/RidersList"));
const RiderDetail = lazyPage(() => import("@/pages/organizer/RiderDetail"));
const RfidManagement = lazyPage(() => import("@/pages/organizer/RfidManagement"));
const ReaderSetup = lazyPage(() => import("@/pages/organizer/ReaderSetup"));
const OfflineMode = lazyPage(() => import("@/pages/organizer/OfflineMode"));
const OfflineSync = lazyPage(() => import("@/pages/organizer/OfflineSync"));
const Series = lazyPage(() => import("@/pages/organizer/Series"));
const PointsTables = lazyPage(() => import("@/pages/organizer/PointsTables"));
const ClubsAdmin = lazyPage(() => import("@/pages/organizer/ClubsAdmin"));
const UsersAdmin = lazyPage(() => import("@/pages/organizer/UsersAdmin"));
const AdminNotifications = lazyPage(() => import("@/pages/organizer/AdminNotifications"));
const SupportTickets = lazyPage(() => import("@/pages/organizer/SupportTickets"));
const RaceGasAdmin = lazyPage(() => import("@/pages/organizer/RaceGasAdmin"));
const StripeConnect = lazyPage(() => import("@/pages/organizer/StripeConnect"));
const StandalonePractice = lazyPage(() => import("@/pages/organizer/StandalonePractice"));
const DiscountCodesPage = lazyPage(() => import("@/pages/organizer/DiscountCodes"));
const TeamPage = lazyPage(() => import("@/pages/organizer/TeamPage"));
const StaffPage = lazyPage(() => import("@/pages/organizer/StaffPage"));
const Notifications = lazyPage(() =>
  import("@/pages/organizer/Notifications").then((m) => ({ default: m.Notifications })),
);
const RaceDayDisplayPage = lazyPage(() => import("@/pages/organizer/RaceDayDisplayPage"));
const NoAccessPage = lazyPage(() => import("@/pages/organizer/NoAccessPage"));

// The organizer shell (sidebar, assistant, tour) and the desktop-only dialogs
// aren't needed by spectators or riders either.
const OrganizerLayoutImpl = lazyPage(() =>
  import("@/components/layout/OrganizerLayout").then((m) => ({ default: m.OrganizerLayout })),
);
// The offline banner animates with framer-motion (~40 KB gzipped): load it just
// after the page instead of before it. It loads on every visit, so the service
// worker's code cache has it before the signal drops.
const OfflineBanner = lazy(() =>
  import("@/components/OfflineBanner").then((m) => ({ default: m.OfflineBanner })),
);
const DesktopSyncModal = lazy(() =>
  import("@/components/DesktopSyncModal").then((m) => ({ default: m.DesktopSyncModal })),
);
const DesktopSerialModal = lazy(() =>
  import("@/components/DesktopSerialModal").then((m) => ({ default: m.DesktopSerialModal })),
);

const SPECTATOR_PAGES = [Results, EventResults, LiveLeaderboard];

// Event pages first: check-in and race day are what an organizer needs if the
// signal drops. The export libraries come last (they're used from buttons).
const ORGANIZER_PRELOADS = [
  OrganizerLayoutImpl, EventLayout, Dashboard, EventsList, Riders, RiderDetail, OfflineMode, OfflineSync,
  ReaderSetup, RfidManagement, StandalonePractice, Series, PointsTables, Notifications,
  RaceDayDisplayPage, GateSchedulePage, MobileGateSchedulePage, StripeConnect,
  DiscountCodesPage, TeamPage, StaffPage, NoAccessPage,
  { preload: () => import("jspdf") },
  { preload: () => import("jspdf-autotable") },
  { preload: () => import("xlsx") },
];

/** The desktop app serves every file from its own local server: nothing to preload. */
const isDesktopApp = () => typeof window !== "undefined" && !!(window as any).electronAPI;

let organizerPreloadStarted = false;
function useOrganizerPreload(enabled: boolean) {
  useEffect(() => {
    if (!enabled || organizerPreloadStarted || isDesktopApp()) return;
    organizerPreloadStarted = true;
    preloadWhenIdle(ORGANIZER_PRELOADS);
  }, [enabled]);
}

/** On the home page, fetch the pages a spectator opens next while the phone is idle. */
function SpectatorPreload() {
  useEffect(() => {
    if (isDesktopApp()) return;
    return preloadWhenIdle(SPECTATOR_PAGES);
  }, []);
  return null;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

/**
 * Listens for Electron sync-engine state changes and invalidates all React
 * Query caches whenever a cloud pull completes.
 *
 * Triggers on syncing → idle  (push + pull both succeeded)
 *         and syncing → error (push failed but pull still ran — new cloud
 *                              data is in SQLite even though local writes
 *                              are still queued for retry).
 *
 * This ensures events/riders/etc appear immediately after the first sync
 * without requiring the user to navigate away and back.
 */
function DesktopSyncWatcher() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.sync?.onChange) return;
    let prevStatus = "";
    // Throttle invalidations: even when rowsChanged is true we won't hammer
    // every 2 s.  The desktop sync-engine's upserts count identical rows as
    // "changed" (SQLite ON CONFLICT DO UPDATE has no WHERE guard), so
    // rowsChanged is often true on no-op cycles.  We cap at one invalidation
    // per 5 s so waiver history / auth / etc. don't refetch constantly.
    let lastInvalidateMs = 0;
    api.sync.getState?.().then((state: { status: string }) => {
      prevStatus = state.status;
    }).catch(() => {});
    const unsub = api.sync.onChange((state: { status: string; rowsChanged?: boolean }) => {
      if (prevStatus === "syncing" && (state.status === "idle" || state.status === "error")) {
        // rowsChanged === false → confirmed no-op, skip.
        // rowsChanged === true/undefined → rows may have changed; invalidate,
        // but no more than once every 5 seconds to prevent UI churn.
        if (state.rowsChanged !== false) {
          const now = Date.now();
          if (now - lastInvalidateMs >= 5_000) {
            lastInvalidateMs = now;
            queryClient.invalidateQueries();
          }
        }
      }
      prevStatus = state.status;
    });
    return () => { if (typeof unsub === "function") unsub(); };
  }, [queryClient]);
  return null;
}

const Loading = () => <RouteLoading variant="screen" />;

/** The organizer portal's layout around a lazily loaded page. */
function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  return (
    <RouteErrorBoundary variant="screen" resetKey={location}>
      <Suspense fallback={<Loading />}>
        <OrganizerLayoutImpl><RouteBoundary>{children}</RouteBoundary></OrganizerLayoutImpl>
      </Suspense>
    </RouteErrorBoundary>
  );
}

/** The login page, coming back here after signing in. */
function loginWithNext(): string {
  const here = window.location.pathname + window.location.search;
  return here && here !== "/" ? `/login?next=${encodeURIComponent(here)}` : "/login";
}

/**
 * ProtectedRoute — requires authentication.
 * If permKey is provided, staff users must have that permission or they land on /no-access.
 */
function ProtectedRoute({ children, permKey }: { children: React.ReactNode; permKey?: string }) {
  const { isAuthenticated, isLoading, user, permissions } = useAuth();
  useOrganizerPreload(isAuthenticated);
  if (isLoading) return <Loading />;
  if (!isAuthenticated) return <Redirect to={loginWithNext()} />;

  // Staff permission enforcement
  if (user?.role === "staff" && permKey && !permissions.includes(permKey)) {
    return <Redirect to="/no-access" />;
  }

  return <OrganizerLayout>{children}</OrganizerLayout>;
}

/** OrganizerOnlyRoute — redirects staff back to their landing destination. */
function OrganizerOnlyRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth();
  useOrganizerPreload(isAuthenticated);
  if (isLoading) return <Loading />;
  if (!isAuthenticated) return <Redirect to={loginWithNext()} />;
  if (user?.role === "staff") return <Redirect to="/no-access" />;
  return <OrganizerLayout>{children}</OrganizerLayout>;
}


function RiderProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useRiderAuth();
  // Remember where the rider was going so sign-in can bring them back.
  const here = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/rider/home";
  if (isLoading) return (
    <div className="rider-theme flex items-center justify-center h-screen">
      <div className="font-heading text-xl uppercase tracking-widest animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
  if (!isAuthenticated) return <Redirect to={`/rider/login?next=${encodeURIComponent(here)}`} />;
  return <RouteBoundary variant="rider">{children}</RouteBoundary>;
}

function Router() {
  return (
    <Switch>
      {/* ── Public routes ── */}
      <Route path="/">
        <SpectatorPreload />
        <PublicLayout><Home /></PublicLayout>
      </Route>
      <Route path="/privacy">
        <RouteBoundary><PrivacyPolicy /></RouteBoundary>
      </Route>
      <Route path="/terms">
        <RouteBoundary><TermsAndConditions /></RouteBoundary>
      </Route>
      <Route path="/delete-account">
        <RouteBoundary><DeleteAccount /></RouteBoundary>
      </Route>
      <Route path="/rider/reset-password">
        <RouteBoundary variant="rider"><ResetRiderPassword /></RouteBoundary>
      </Route>
      <Route path="/rider-app">
        <RouteBoundary><RiderAppLanding /></RouteBoundary>
      </Route>
      {/* Rider live video: the app's Go Live screen and the viewer (not linked from any public page). */}
      <Route path="/phone-live/:riderId">
        <RouteBoundary variant="screen"><PhoneLive /></RouteBoundary>
      </Route>
      <Route path="/rider-live/:riderId">
        <RouteBoundary variant="screen"><RiderLiveWatch /></RouteBoundary>
      </Route>
      <Route path="/racer/:riderId">
        <PublicLayout><RouteBoundary><PublicRacer /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/results">
        <PublicLayout><RouteBoundary><Results /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/results/:eventId">
        <PublicLayout><RouteBoundary><EventResults /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/leaderboard">
        <PublicLayout><RouteBoundary><Leaderboard /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/login">
        <PublicLayout><RouteBoundary><Login /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/setup-account">
        <PublicLayout><RouteBoundary><SetPassword /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/support/decide">
        <PublicLayout><RouteBoundary><SupportDecision /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/forgot-password">
        <PublicLayout><RouteBoundary><ForgotPassword /></RouteBoundary></PublicLayout>
      </Route>
      {/* The rider app's in-app PDF viewer (waivers): no site header. */}
      <Route path="/pdf-view">
        <RouteBoundary><PdfView /></RouteBoundary>
      </Route>
      <Route path="/register/:eventId">
        <PublicLayout><RouteBoundary><Register /></RouteBoundary></PublicLayout>
      </Route>
      <Route path="/live/:motoId">
        <RouteBoundary variant="screen"><LiveLeaderboard /></RouteBoundary>
      </Route>
      <Route path="/watch/:eventId">
        <RouteBoundary variant="screen"><WatchLive /></RouteBoundary>
      </Route>
      <Route path="/scan">
        <RouteBoundary variant="screen"><HandScanner /></RouteBoundary>
      </Route>
      <Route path="/widget/series/:seriesId">
        <RouteBoundary><SeriesWidget /></RouteBoundary>
      </Route>
      <Route path="/widget/:eventId">
        <RouteBoundary><EventWidget /></RouteBoundary>
      </Route>

      {/* ── Rider portal ── */}
      <Route path="/rider/login">
        <RouteBoundary variant="rider"><RiderLogin /></RouteBoundary>
      </Route>
      <Route path="/rider">
        <Redirect to="/rider/home" />
      </Route>
      <Route path="/rider/home">
        <RiderProtectedRoute><RiderHome /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/races">
        <RiderProtectedRoute><RiderRaces /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/results">
        <RiderProtectedRoute><RiderResults /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/train">
        <RiderProtectedRoute><RiderTrain /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/mechanic">
        <RiderProtectedRoute><RiderMechanic /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/new-profile">
        <RiderProtectedRoute><RiderCreateProfile /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/racer/:riderId">
        <RiderProtectedRoute><RacerProfile /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/following">
        <RiderProtectedRoute><RiderFollowing /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/portal/:riderId">
        <RiderProtectedRoute><RiderHistory /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/portal">
        <RiderProtectedRoute><RiderPortal /></RiderProtectedRoute>
      </Route>
      <Route path="/rider/rm-cash">
        <RiderProtectedRoute><RmCash /></RiderProtectedRoute>
      </Route>

      {/* ── Gate Schedule — public shareable link, no login required ── */}
      <Route path="/gate">
        <RouteBoundary><GateSchedulePage /></RouteBoundary>
      </Route>

      {/* ── Mobile gate schedule — shared from Admin page, mobile-optimised ── */}
      <Route path="/gate-mobile">
        <RouteBoundary><MobileGateSchedulePage /></RouteBoundary>
      </Route>

      {/* ── No-access landing for restricted staff ── */}
      <Route path="/no-access">
        <ProtectedRoute><NoAccessPage /></ProtectedRoute>
      </Route>

      {/* ── Organizer portal — per-page permission guards ── */}
      <Route path="/dashboard">
        <ProtectedRoute permKey="dashboard"><Dashboard /></ProtectedRoute>
      </Route>
      <Route path="/events">
        <ProtectedRoute permKey="events"><EventsList /></ProtectedRoute>
      </Route>
      <Route path="/events/:eventId/*?">
        <ProtectedRoute permKey="events"><EventLayout /></ProtectedRoute>
      </Route>
      <Route path="/riders">
        <ProtectedRoute permKey="riders"><Riders /></ProtectedRoute>
      </Route>
      <Route path="/riders/:riderId">
        <ProtectedRoute permKey="riders"><RiderDetail /></ProtectedRoute>
      </Route>
      <Route path="/rfid/setup">
        <ProtectedRoute permKey="reader_setup"><ReaderSetup /></ProtectedRoute>
      </Route>
      <Route path="/offline-mode">
        <ProtectedRoute permKey="offline_mode"><OfflineMode /></ProtectedRoute>
      </Route>
      <Route path="/offline/sync">
        <ProtectedRoute permKey="offline_mode"><OfflineSync /></ProtectedRoute>
      </Route>
      <Route path="/rfid">
        <ProtectedRoute permKey="reader_setup"><RfidManagement /></ProtectedRoute>
      </Route>
      <Route path="/series">
        <ProtectedRoute permKey="series"><Series /></ProtectedRoute>
      </Route>
      <Route path="/points-tables">
        <ProtectedRoute permKey="points_tables"><PointsTables /></ProtectedRoute>
      </Route>
      <Route path="/payments">
        <ProtectedRoute permKey="payments"><StripeConnect /></ProtectedRoute>
      </Route>
      <Route path="/discount-codes">
        <ProtectedRoute permKey="discount_codes"><DiscountCodesPage /></ProtectedRoute>
      </Route>
      <Route path="/practice">
        <ProtectedRoute permKey="practice"><StandalonePractice /></ProtectedRoute>
      </Route>

      <Route path="/notifications">
        <ProtectedRoute permKey="notifications"><Notifications /></ProtectedRoute>
      </Route>
      <Route path="/race-day-display">
        <ProtectedRoute permKey="gate_schedule"><RaceDayDisplayPage /></ProtectedRoute>
      </Route>

      {/* ── Organizer / admin only ── */}
      <Route path="/team">
        <OrganizerOnlyRoute><TeamPage /></OrganizerOnlyRoute>
      </Route>
      <Route path="/staff">
        <OrganizerOnlyRoute><StaffPage /></OrganizerOnlyRoute>
      </Route>
      <Route path="/admin/clubs">
        <OrganizerOnlyRoute><ClubsAdmin /></OrganizerOnlyRoute>
      </Route>
      <Route path="/admin/users">
        <OrganizerOnlyRoute><UsersAdmin /></OrganizerOnlyRoute>
      </Route>
      <Route path="/admin/notifications">
        <OrganizerOnlyRoute><AdminNotifications /></OrganizerOnlyRoute>
      </Route>
      <Route path="/admin/support">
        <OrganizerOnlyRoute><SupportTickets /></OrganizerOnlyRoute>
      </Route>
      <Route path="/admin/race-gas">
        <OrganizerOnlyRoute><RaceGasAdmin /></OrganizerOnlyRoute>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

/** Default tab title for the current route (lib/documentTitle.ts). */
function RouteTitle() {
  useRouteTitle();
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RiderAuthProvider>
          <BroadcastProvider>
            <TooltipProvider>
              <DesktopSyncWatcher />
              <OptionalLazy>
                <OfflineBanner />
              </OptionalLazy>
              <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "")}>
                {/* Before the routes, so a page's own title (set in its effects) wins. */}
                <RouteTitle />
                <Router />
              </WouterRouter>
              <Toaster />
              {isDesktopApp() && (
                <OptionalLazy>
                  <DesktopSyncModal />
                  <DesktopSerialModal />
                </OptionalLazy>
              )}
            </TooltipProvider>
          </BroadcastProvider>
        </RiderAuthProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
