import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { RiderAuthProvider, useRiderAuth } from "@/contexts/RiderAuthContext";
import { BroadcastProvider } from "@/contexts/BroadcastContext";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { OrganizerLayout } from "@/components/layout/OrganizerLayout";
import { OfflineBanner } from "@/components/OfflineBanner";
import { DesktopSyncModal } from "@/components/DesktopSyncModal";
import { DesktopSerialModal } from "@/components/DesktopSerialModal";
import NotFound from "@/pages/not-found";

import Home from "@/pages/public/Home";
import Results from "@/pages/public/Results";
import EventResults from "@/pages/public/EventResults";
import Leaderboard from "@/pages/public/Leaderboard";
import Login from "@/pages/public/Login";
import Register from "@/pages/public/Register";
import LiveLeaderboard from "@/pages/public/LiveLeaderboard";

import Dashboard from "@/pages/organizer/Dashboard";
import EventLayout from "@/pages/organizer/EventLayout";
import EventsList from "@/pages/organizer/EventsList";
import Riders from "@/pages/organizer/RidersList";
import RiderDetail from "@/pages/organizer/RiderDetail";
import RfidManagement from "@/pages/organizer/RfidManagement";
import ReaderSetup from "@/pages/organizer/ReaderSetup";
import OfflineMode from "@/pages/organizer/OfflineMode";
import OfflineSync from "@/pages/organizer/OfflineSync";
import Series from "@/pages/organizer/Series";
import PointsTables from "@/pages/organizer/PointsTables";
import ClubsAdmin from "@/pages/organizer/ClubsAdmin";
import UsersAdmin from "@/pages/organizer/UsersAdmin";
import AdminNotifications from "@/pages/organizer/AdminNotifications";
import SetPassword from "@/pages/public/SetPassword";
import StripeConnect from "@/pages/organizer/StripeConnect";
import StandalonePractice from "@/pages/organizer/StandalonePractice";
import DiscountCodesPage from "@/pages/organizer/DiscountCodes";
import TeamPage from "@/pages/organizer/TeamPage";
import { Notifications } from "@/pages/organizer/Notifications";
import GateSchedulePage from "@/pages/organizer/GateSchedulePage";
import NoAccessPage from "@/pages/organizer/NoAccessPage";
import RiderLogin from "@/pages/rider/RiderLogin";
import RiderPortal from "@/pages/rider/RiderPortal";
import RiderHistory from "@/pages/rider/RiderHistory";
import RiderCreateProfile from "@/pages/rider/RiderCreateProfile";
import RmCash from "@/pages/rider/RmCash";
import WatchLive from "@/pages/public/WatchLive";
import EventWidget from "@/pages/public/EventWidget";
import SeriesWidget from "@/pages/public/SeriesWidget";

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
 * Query caches whenever a cloud pull completes (syncing → idle transition).
 * This ensures events/riders/etc appear immediately after the first sync
 * without requiring the user to navigate away and back.
 */
function DesktopSyncWatcher() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.sync?.onChange) return;
    let prevStatus = "";
    api.sync.getState?.().then((state: { status: string }) => {
      prevStatus = state.status;
    }).catch(() => {});
    const unsub = api.sync.onChange((state: { status: string }) => {
      if (prevStatus === "syncing" && state.status === "idle") {
        queryClient.invalidateQueries();
      }
      prevStatus = state.status;
    });
    return () => { if (typeof unsub === "function") unsub(); };
  }, [queryClient]);
  return null;
}

const Loading = () => (
  <div className="flex items-center justify-center h-screen bg-sidebar">
    <div className="text-white font-heading text-xl uppercase tracking-widest animate-pulse">Loading...</div>
  </div>
);

/**
 * ProtectedRoute — requires authentication.
 * If permKey is provided, staff users must have that permission or they land on /no-access.
 */
function ProtectedRoute({ children, permKey }: { children: React.ReactNode; permKey?: string }) {
  const { isAuthenticated, isLoading, user, permissions } = useAuth();
  if (isLoading) return <Loading />;
  if (!isAuthenticated) return <Redirect to="/login" />;

  // Staff permission enforcement
  if (user?.role === "staff" && permKey && !permissions.includes(permKey)) {
    return <Redirect to="/no-access" />;
  }

  return <OrganizerLayout>{children}</OrganizerLayout>;
}

/** OrganizerOnlyRoute — redirects staff back to their landing destination. */
function OrganizerOnlyRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth();
  if (isLoading) return <Loading />;
  if (!isAuthenticated) return <Redirect to="/login" />;
  if (user?.role === "staff") return <Redirect to="/no-access" />;
  return <OrganizerLayout>{children}</OrganizerLayout>;
}


function RiderProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useRiderAuth();
  if (isLoading) return (
    <div className="flex items-center justify-center h-screen">
      <div className="font-heading text-xl uppercase tracking-widest animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
  if (!isAuthenticated) return <Redirect to="/rider/login" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      {/* ── Public routes ── */}
      <Route path="/">
        <PublicLayout><Home /></PublicLayout>
      </Route>
      <Route path="/results">
        <PublicLayout><Results /></PublicLayout>
      </Route>
      <Route path="/results/:eventId">
        <PublicLayout><EventResults /></PublicLayout>
      </Route>
      <Route path="/leaderboard">
        <PublicLayout><Leaderboard /></PublicLayout>
      </Route>
      <Route path="/login">
        <PublicLayout><Login /></PublicLayout>
      </Route>
      <Route path="/setup-account">
        <PublicLayout><SetPassword /></PublicLayout>
      </Route>
      <Route path="/register/:eventId">
        <Register />
      </Route>
      <Route path="/live/:motoId">
        <LiveLeaderboard />
      </Route>
      <Route path="/watch/:eventId">
        <WatchLive />
      </Route>
      <Route path="/widget/series/:seriesId">
        <SeriesWidget />
      </Route>
      <Route path="/widget/:eventId">
        <EventWidget />
      </Route>

      {/* ── Rider portal ── */}
      <Route path="/rider/login">
        <RiderLogin />
      </Route>
      <Route path="/rider/new-profile">
        <RiderProtectedRoute><RiderCreateProfile /></RiderProtectedRoute>
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
        <GateSchedulePage />
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

      {/* ── Organizer / admin only ── */}
      <Route path="/team">
        <OrganizerOnlyRoute><TeamPage /></OrganizerOnlyRoute>
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

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RiderAuthProvider>
          <BroadcastProvider>
            <TooltipProvider>
              <DesktopSyncWatcher />
              <OfflineBanner />
              <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
              <Toaster />
              <DesktopSyncModal />
              <DesktopSerialModal />
            </TooltipProvider>
          </BroadcastProvider>
        </RiderAuthProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
