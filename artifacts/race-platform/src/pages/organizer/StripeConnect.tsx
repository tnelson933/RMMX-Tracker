import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CreditCard, CheckCircle2, AlertCircle, ExternalLink, Loader2, ArrowRight, Unlink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

function useStripeConnectStatus() {
  return useQuery({
    queryKey: ["stripe-connect-status"],
    queryFn: async () => {
      const res = await fetch("/api/stripe/connect/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch Stripe Connect status");
      return res.json() as Promise<{ connected: boolean; onboardingComplete: boolean; accountId: string | null }>;
    },
  });
}

export default function StripeConnect() {
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const [justConnected, setJustConnected] = useState(false);
  const [stripeEmail, setStripeEmail] = useState("");

  const { data: status, isLoading, refetch } = useStripeConnectStatus();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      setJustConnected(true);
      refetch();
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("refresh") === "1") {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Pre-fill email from user account once loaded
  useEffect(() => {
    if (user?.email && !stripeEmail) {
      setStripeEmail(user.email);
    }
  }, [user?.email]);

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/stripe/connect/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: stripeEmail.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to start Stripe Connect");
      }
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.open(data.url, "_blank");
    },
    onError: (err: Error) => {
      const isConnectNotEnabled = err.message?.toLowerCase().includes("signed up for connect");
      toast({
        title: "Stripe Connect not enabled",
        description: isConnectNotEnabled
          ? "Your Stripe account hasn't enabled Connect yet. Visit dashboard.stripe.com/connect to activate it, then try again."
          : err.message,
        variant: "destructive",
      });
    },
  });

  const dashboardMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/stripe/connect/dashboard-link", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to open dashboard");
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.open(data.url, "_blank");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/stripe/connect", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to disconnect");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stripe-connect-status"] });
      toast({ title: "Disconnected", description: "Your Stripe account has been disconnected." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">Payments</h1>
        <p className="text-muted-foreground mt-1">
          Connect your Stripe account to collect entry fees from riders at registration.
        </p>
      </div>

      {justConnected && (
        <Alert className="border-green-500/30 bg-green-500/5">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700">
            Your Stripe account has been connected! You can now enable payment collection on events.
          </AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center h-40">
            <Loader2 className="animate-spin text-muted-foreground" size={28} />
          </CardContent>
        </Card>
      ) : !status?.connected ? (
        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="bg-muted rounded-full p-3">
                <CreditCard size={24} className="text-muted-foreground" />
              </div>
              <div>
                <CardTitle className="font-heading uppercase">Connect with Stripe</CardTitle>
                <CardDescription>Accept payments directly to your bank account</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="text-sm text-muted-foreground space-y-2">
              <li className="flex items-center gap-2"><CheckCircle2 size={14} className="text-green-500 shrink-0" /> Collect entry fees at registration</li>
              <li className="flex items-center gap-2"><CheckCircle2 size={14} className="text-green-500 shrink-0" /> Funds deposited directly to your bank</li>
              <li className="flex items-center gap-2"><CheckCircle2 size={14} className="text-green-500 shrink-0" /> Stripe handles card processing &amp; compliance</li>
              <li className="flex items-center gap-2"><CheckCircle2 size={14} className="text-green-500 shrink-0" /> Full payout history and reporting in Stripe dashboard</li>
            </ul>
            <div className="space-y-1.5 pt-1">
              <Label htmlFor="stripe-email" className="text-sm font-medium">
                Stripe account email
              </Label>
              <Input
                id="stripe-email"
                type="email"
                placeholder="you@example.com"
                value={stripeEmail}
                onChange={(e) => setStripeEmail(e.target.value)}
                className="max-w-sm"
              />
              <p className="text-xs text-muted-foreground">
                Stripe will use this to set up or link your payout account.
              </p>
            </div>
            <Button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending}
              className="font-heading uppercase tracking-wider"
              size="lg"
            >
              {startMutation.isPending ? (
                <><Loader2 size={16} className="mr-2 animate-spin" /> Connecting...</>
              ) : (
                <><CreditCard size={16} className="mr-2" /> Connect with Stripe <ArrowRight size={16} className="ml-2" /></>
              )}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-green-500/30">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="bg-green-500/10 rounded-full p-3">
                <CheckCircle2 size={24} className="text-green-600" />
              </div>
              <div>
                <CardTitle className="font-heading uppercase flex items-center gap-2">
                  Stripe Connected
                  <Badge className="bg-green-500/15 text-green-700 border-green-500/30 text-xs normal-case font-normal">Active</Badge>
                </CardTitle>
                <CardDescription>Payment collection is enabled for your club</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Connected account email */}
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <CreditCard size={16} className="text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide leading-none mb-0.5">Connected account</p>
                  <p className="text-sm font-medium truncate">{(status as any)?.email ?? "Stripe account"}</p>
                </div>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-muted-foreground shrink-0 ml-4">
                    <Unlink size={14} className="mr-1" /> Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Stripe Account?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Disconnecting will disable payment collection for your events. Any existing registrations with payments won't be affected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => disconnectMutation.mutate()}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            {!status?.onboardingComplete && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>Your Stripe account setup isn't fully complete. <button onClick={() => startMutation.mutate()} className="underline underline-offset-2 font-medium hover:opacity-80">Finish setup</button> to activate payouts.</span>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              Payment collection is active. On any event, open the edit form and check <strong>Collect Payments</strong> to charge riders an entry fee at registration.
            </p>
            <Button
              onClick={() => dashboardMutation.mutate()}
              disabled={dashboardMutation.isPending}
              variant="outline"
              className="font-heading uppercase tracking-wider"
            >
              {dashboardMutation.isPending ? (
                <><Loader2 size={16} className="mr-2 animate-spin" /> Loading...</>
              ) : (
                <><ExternalLink size={16} className="mr-2" /> Open Stripe Dashboard</>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <h3 className="font-heading font-semibold uppercase tracking-wide text-sm mb-3">How it works</h3>
          <div className="grid gap-3 sm:grid-cols-3 text-sm text-muted-foreground">
            <div className="space-y-1">
              <div className="font-medium text-foreground">1. Connect</div>
              <div>
                Set up your Stripe Express account with your banking info. First-time setup requires{" "}
                <a
                  href="https://dashboard.stripe.com/connect"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:opacity-80"
                >
                  enabling Connect
                </a>{" "}
                on your Stripe account.
              </div>
            </div>
            <div className="space-y-1">
              <div className="font-medium text-foreground">2. Enable on Events</div>
              <div>Check "Collect Payments" and set an entry fee when creating events</div>
            </div>
            <div className="space-y-1">
              <div className="font-medium text-foreground">3. Get Paid</div>
              <div>Riders pay at registration and funds deposit directly to your account</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
