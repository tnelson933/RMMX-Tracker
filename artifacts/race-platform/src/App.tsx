import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { RiderAuthProvider, useRiderAuth } from "@/contexts/RiderAuthContext";
import { BroadcastProvider } from "@/contexts/BroadcastContext";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { OrganizerLayout } from "@/components/layout/OrganizerLayout";
import { OfflineBanner } from "@/components/OfflineBanner";
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
import SetPassword from "@/pages/public/SetPassword";
import StripeConnect from "@/pages/organizer/StripeConnect";
import StandalonePractice from "@/pages/organizer/StandalonePractice";
import GateAssignments from "@/pages/organizer/GateAssignments";
import RiderLogin from "@/pages/rider/RiderLogin";
import RiderPortal from "@/pages/rider/RiderPortal";
import RiderHistory from "@/pages/rider/RiderHistory";
import RiderCreateProfile from "@/pages/rider/RiderCreateProfile";
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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <div className="flex items-center justify-center h-screen bg-sidebar"><div className="text-white font-heading text-xl uppercase tracking-widest animate-pulse">Loading...</div></div>;
  if (!isAuthenticated) return <Redirect to="/login" />;
  return <OrganizerLayout>{children}</OrganizerLayout>;
}

function RiderProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useRiderAuth();
  if (isLoading) return <div className="flex items-center justify-center h-screen"><div className="font-heading text-xl uppercase tracking-widest animate-pulse text-muted-foreground">Loading...</div></div>;
  if (!isAuthenticated) return <Redirect to="/rider/login" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
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

      <Route path="/dashboard">
        <ProtectedRoute><Dashboard /></ProtectedRoute>
      </Route>
      <Route path="/events">
        <ProtectedRoute><EventsList /></ProtectedRoute>
      </Route>
      <Route path="/events/:eventId/*?">
        <ProtectedRoute><EventLayout /></ProtectedRoute>
      </Route>
      <Route path="/riders">
        <ProtectedRoute><Riders /></ProtectedRoute>
      </Route>
      <Route path="/riders/:riderId">
        <ProtectedRoute><RiderDetail /></ProtectedRoute>
      </Route>
      <Route path="/rfid/setup">
        <ProtectedRoute><ReaderSetup /></ProtectedRoute>
      </Route>
      <Route path="/offline-mode">
        <ProtectedRoute><OfflineMode /></ProtectedRoute>
      </Route>
      <Route path="/offline/sync">
        <ProtectedRoute><OfflineSync /></ProtectedRoute>
      </Route>
      <Route path="/rfid">
        <ProtectedRoute><RfidManagement /></ProtectedRoute>
      </Route>
      <Route path="/series">
        <ProtectedRoute><Series /></ProtectedRoute>
      </Route>
      <Route path="/points-tables">
        <ProtectedRoute><PointsTables /></ProtectedRoute>
      </Route>
      <Route path="/admin/clubs">
        <ProtectedRoute><ClubsAdmin /></ProtectedRoute>
      </Route>
      <Route path="/admin/users">
        <ProtectedRoute><UsersAdmin /></ProtectedRoute>
      </Route>
      <Route path="/payments">
        <ProtectedRoute><StripeConnect /></ProtectedRoute>
      </Route>
      <Route path="/practice">
        <ProtectedRoute><StandalonePractice /></ProtectedRoute>
      </Route>
      <Route path="/gate-assignments">
        <ProtectedRoute><GateAssignments /></ProtectedRoute>
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
              <OfflineBanner />
              <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </BroadcastProvider>
        </RiderAuthProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
