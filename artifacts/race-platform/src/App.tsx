import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { OrganizerLayout } from "@/components/layout/OrganizerLayout";
import NotFound from "@/pages/not-found";

import Home from "@/pages/public/Home";
import Results from "@/pages/public/Results";
import EventResults from "@/pages/public/EventResults";
import Leaderboard from "@/pages/public/Leaderboard";
import Login from "@/pages/public/Login";

import Dashboard from "@/pages/organizer/Dashboard";
import EventLayout from "@/pages/organizer/EventLayout";
import EventsList from "@/pages/organizer/EventsList";
import Riders from "@/pages/organizer/RidersList";
import RiderDetail from "@/pages/organizer/RiderDetail";
import RfidManagement from "@/pages/organizer/RfidManagement";
import Series from "@/pages/organizer/Series";

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
      <Route path="/rfid">
        <ProtectedRoute><RfidManagement /></ProtectedRoute>
      </Route>
      <Route path="/series">
        <ProtectedRoute><Series /></ProtectedRoute>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
