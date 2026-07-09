import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { ShieldAlert, KeyRound, Eye, EyeOff, RefreshCw } from "lucide-react";
import rmLogo from "@assets/rm-logo.png";
import { Alert, AlertDescription } from "@/components/ui/alert";

const isDesktop = typeof (window as any).electronAPI !== "undefined";

const VITE_CLOUD_URL = (import.meta as any).env?.VITE_CLOUD_URL as string | undefined;

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
  rememberMe: z.boolean().default(false),
  cloudUrl: z.string().optional().default(""),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const loginMutation = useLogin();
  const { isAuthenticated } = useAuth();
  const [authError, setAuthError] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);

  useEffect(() => {
    if (isAuthenticated) setLocation("/dashboard");
  }, [isAuthenticated, setLocation]);

  const savedEmail = typeof localStorage !== "undefined" ? (localStorage.getItem("rmmx_saved_email") ?? "") : "";

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: savedEmail,
      password: "",
      rememberMe: !!savedEmail,
      cloudUrl: VITE_CLOUD_URL ?? "",
    },
  });

  const attemptLocalLogin = (data: LoginFormValues) => {
    loginMutation.mutate(
      { data: { email: data.email, password: data.password, rememberMe: data.rememberMe } },
      {
        onSuccess: async () => {
          if (data.rememberMe) {
            localStorage.setItem("rmmx_saved_email", data.email);
          } else {
            localStorage.removeItem("rmmx_saved_email");
          }
          if (isDesktop) {
            const api = (window as any).electronAPI;

            // Check whether cloud sync is already configured (credentials saved).
            let hasSyncUrl = false;
            try {
              const state = (await api?.sync?.getState?.()) as { cloudUrl?: string | null } | null;
              hasSyncUrl = !!state?.cloudUrl;
            } catch { /* ignore */ }

            if (!hasSyncUrl && VITE_CLOUD_URL) {
              // Sync engine not running — credentials were never saved or were
              // cleared (e.g. fresh install, app update).  Auto-configure it now
              // using the credentials the user just proved are valid locally.
              setCloudSyncing(true);
              try {
                await api?.auth?.cloudLogin(data.email, data.password, VITE_CLOUD_URL);
              } catch { /* non-fatal */ }
              setCloudSyncing(false);
            } else if (hasSyncUrl) {
              // Sync is configured — flush and wait so SQLite is fully populated
              // before we invalidate the cache and the dashboard loads.
              try { await api?.sync?.flush?.(); } catch { /* non-fatal */ }
            }

            // Wipe all query caches so the dashboard refetches from the
            // now-populated SQLite rather than serving stale empty snapshots.
            await queryClient.invalidateQueries();
          }
          // Always invalidate first to clear any cached 401 error state from
          // before login, then refetch so isAuthenticated flips to true and
          // the redirect useEffect fires reliably on the first attempt.
          await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          await queryClient.refetchQueries({ queryKey: getGetMeQueryKey() });
        },
        onError: async (error: any) => {
          // error.data is the parsed JSON response body (ApiError from custom-fetch)
          // error.response is the raw fetch Response object — it has no .data property
          const status = error?.status as number | undefined;
          const serverMsg: string | undefined =
            error?.data?.error || error?.data?.message;

          // Club suspended — show specific message regardless of platform
          if (
            serverMsg === "CLUB_INACTIVE" ||
            String(serverMsg ?? "").includes("CLUB_INACTIVE") ||
            String(error?.message ?? "").includes("CLUB_INACTIVE")
          ) {
            setAuthError("CLUB_INACTIVE");
            return;
          }

          // Build a human-readable error string
          let apiError: string;
          if (status !== undefined && status >= 500) {
            apiError = "The server is temporarily unavailable. Please try again in a moment.";
          } else if (serverMsg) {
            apiError = serverMsg;
          } else {
            apiError = error?.message || "Incorrect email or password. Please try again.";
          }

          // On desktop: if the local user doesn't exist yet (first install) or has
          // no password hash (account not activated locally), automatically try to
          // log in to the cloud and pull all data down, then retry locally.
          if (isDesktop) {
            const fallbackUrl = data.cloudUrl?.trim() || VITE_CLOUD_URL || (window as any).electronAPI?.getCloudUrl?.() || "";
            setCloudSyncing(true);
            setAuthError(null);
            try {
              const result = await (window as any).electronAPI.auth.cloudLogin(
                data.email,
                data.password,
                fallbackUrl,
              ) as { ok: boolean; error?: string; syncWarning?: string };

              if (result.ok) {
                // Cloud sync succeeded — warn if data pull had issues but still try local login.
                if (result.syncWarning) {
                  setSyncWarning(result.syncWarning);
                }
                // Retry local login with freshly synced data.
                // cloudLogin already awaited flush(), so data is in SQLite.
                // Invalidate all query caches so the dashboard refetches clean data.
                loginMutation.mutate(
                  { data: { email: data.email, password: data.password, rememberMe: data.rememberMe } },
                  {
                    onSuccess: async () => {
                      await queryClient.invalidateQueries();
                      await queryClient.refetchQueries({ queryKey: getGetMeQueryKey() });
                    },
                    onError: (retryErr: any) => {
                      setAuthError(
                        retryErr?.message ||
                          "Sync succeeded but local login still failed. Please try again.",
                      );
                    },
                  },
                );
              } else {
                setAuthError(result.error ?? "Cloud sync failed. Check your credentials.");
              }
            } catch (e: any) {
              setAuthError(e?.message || "Cloud sync failed. Check your connection.");
            } finally {
              setCloudSyncing(false);
            }
          } else {
            setAuthError(apiError);
          }
        },
      },
    );
  };

  const onSubmit = (data: LoginFormValues) => {
    setAuthError(null);
    setSyncWarning(null);
    attemptLocalLogin(data);
  };

  const isBusy = loginMutation.isPending || cloudSyncing;

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-4 bg-sidebar/5 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl -z-10 pointer-events-none"></div>

      <Card className="w-full max-w-md shadow-2xl border-sidebar-border/20">
        <div className="bg-sidebar p-8 text-center border-b border-sidebar-border relative overflow-hidden">
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjMWExYTFhIj48L3JlY3Q+CjxwYXRoIGQ9Ik0wIDBMOCA4Wk04IDBMMCA4WiIgc3Ryb2tlPSIjMjI0IiBzdHJva2Utd2lkdGg9IjEiPjwvcGF0aD4KPC9zdmc+')] opacity-20"></div>
          <img src={rmLogo} alt="RM Tracker" className="w-16 h-16 mx-auto mb-4 relative z-10 drop-shadow-lg" />
          <CardTitle className="text-3xl font-heading font-bold uppercase tracking-tight text-sidebar-foreground relative z-10">
            Organizer Portal
          </CardTitle>
          <CardDescription className="text-sidebar-foreground/70 mt-2 relative z-10 text-base">
            Secure login for club officials and track staff
          </CardDescription>
        </div>

        <CardContent className="p-8">
          {cloudSyncing && (
            <div className="mb-6 rounded-md border border-blue-400 bg-blue-400/10 px-4 py-3 flex items-center gap-3">
              <RefreshCw size={16} className="text-blue-400 shrink-0 animate-spin" />
              <div className="text-sm text-blue-400 font-medium">
                Syncing your account from the cloud… this takes a few seconds.
              </div>
            </div>
          )}

          {syncWarning && !cloudSyncing && (
            <div className="mb-6 rounded-md border border-yellow-400 bg-yellow-400/10 px-4 py-3 flex items-start gap-3">
              <ShieldAlert size={16} className="text-yellow-400 shrink-0 mt-0.5" />
              <div className="text-sm text-yellow-300">
                <p className="font-semibold mb-1">Cloud sync warning — some data may be missing</p>
                <p className="text-xs opacity-90 font-mono break-all">{syncWarning}</p>
                <p className="text-xs opacity-70 mt-1">Check the cloud URL in Sync Settings and retry login.</p>
              </div>
            </div>
          )}

          {authError && !cloudSyncing && (
            authError === "CLUB_INACTIVE" ? (
              <div className="mb-6 rounded-sm border border-orange-400 bg-orange-400/10 px-4 py-3 flex items-start gap-3">
                <ShieldAlert size={16} className="text-orange-500 shrink-0 mt-0.5" />
                <div className="text-sm text-orange-700 dark:text-orange-400">
                  <p className="font-bold mb-1">Club Membership Inactive</p>
                  <p>Your club has been marked as inactive. Please call Rocky Mountain ATV/MC to reactivate your membership.</p>
                </div>
              </div>
            ) : (
              <Alert variant="destructive" className="mb-6 rounded-sm">
                <AlertDescription className="font-medium text-sm flex flex-col gap-2">
                  <span className="flex items-center gap-2">
                    <ShieldAlert size={16} />
                    {authError}
                  </span>
                  {isDesktop && (
                    <span className="text-xs opacity-90">
                      If the problem persists, open{" "}
                      <button
                        type="button"
                        className="underline font-semibold"
                        onClick={() =>
                          window.dispatchEvent(new CustomEvent("rm-open-sync-settings"))
                        }
                      >
                        Cloud Sync Settings
                      </button>
                      {" "}to verify your cloud URL and club ID.
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-heading uppercase tracking-wider text-muted-foreground font-bold">Email Address</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="official@club.com"
                        {...field}
                        className="h-12 bg-muted/50 focus:bg-background border-muted-foreground/20 text-lg font-medium"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-heading uppercase tracking-wider text-muted-foreground font-bold">Password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type={showPassword ? "text" : "password"}
                          placeholder="••••••••"
                          {...field}
                          className="h-12 bg-muted/50 focus:bg-background border-muted-foreground/20 text-lg tracking-widest font-mono pr-12"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                          tabIndex={-1}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                        >
                          {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                        </button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />


              <FormField
                control={form.control}
                name="rememberMe"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        id="rememberMe"
                        className="border-muted-foreground/40 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                      />
                    </FormControl>
                    <label
                      htmlFor="rememberMe"
                      className="text-sm font-medium text-muted-foreground cursor-pointer select-none leading-none"
                    >
                      Remember me for 30 days
                    </label>
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                className="w-full h-14 text-lg font-heading font-bold uppercase tracking-widest mt-2"
                disabled={isBusy}
              >
                {cloudSyncing ? (
                  <span className="flex items-center gap-2">
                    <RefreshCw size={20} className="animate-spin" />
                    Syncing from cloud…
                  </span>
                ) : loginMutation.isPending ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></span>
                    Authenticating...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <KeyRound size={20} /> Authorize Access
                  </span>
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="bg-muted/30 border-t p-6 text-center text-sm text-muted-foreground font-medium flex flex-col gap-2">
          {isDesktop ? (
            <>
              <span>
                First time on this device?{" "}
                <button
                  type="button"
                  className="text-primary hover:underline font-semibold"
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent("rm-open-sync-settings"))
                  }
                >
                  Open Cloud Sync Settings →
                </button>
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-primary transition-colors"
                onClick={() => {
                  const cloudUrl = (window as any).electronAPI?.getCloudUrl?.() as string | undefined;
                  if (cloudUrl) {
                    window.open(`${cloudUrl}/forgot-password`);
                  } else {
                    window.dispatchEvent(new CustomEvent("rm-open-sync-settings"));
                  }
                }}
              >
                Forgot your password?
              </button>
            </>
          ) : (
            <>
              <span>Authorized personnel only. All access is logged.</span>
              <a href="/setup-account" className="text-primary hover:underline font-semibold">
                First time signing in? Set up your account →
              </a>
              <a href="/forgot-password" className="text-muted-foreground hover:text-primary transition-colors">
                Forgot your password?
              </a>
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
