import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Lock, UserPlus, LogIn, AlertCircle, KeyRound, CheckCircle2 } from "lucide-react";
import { TitleBand } from "@/components/TitleBand";
import { RmCashWidget } from "@/components/layout/RiderLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { riderApi } from "@/lib/rider-api";
import { useRiderAuth } from "@/contexts/RiderAuthContext";

export default function RiderLogin() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useRiderAuth();

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  // true after a successful registration — triggers profile-tab deep-link
  const [fromRegister, setFromRegister] = useState(false);
  // Forgot password: request a reset email from the Sign In tab.
  const search = useSearch();
  // ?forgot=1 (from an expired reset link) opens straight to the reset form.
  const [forgotMode, setForgotMode] = useState(() => new URLSearchParams(search).get("forgot") === "1");
  const [forgotSent, setForgotSent] = useState<string | null>(null);
  // The page a signed-out rider was trying to open (only rider pages).
  const nextParam = new URLSearchParams(search).get("next");
  const next = nextParam && nextParam.startsWith("/rider/") && !nextParam.startsWith("//") && !nextParam.startsWith("/rider/login") ? nextParam : null;

  // Navigate once the auth context confirms the session is live.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (fromRegister) {
      // After registration, jump straight to the profile tab of the first
      // linked rider so they can fill in bike brand, AMA number, etc.
      riderApi.profiles().then(profiles => {
        if (profiles.length === 1) {
          navigate(`/rider/portal/${profiles[0].id}?tab=profile`);
        } else {
          navigate("/rider/portal");
        }
      }).catch(() => navigate("/rider/portal"));
    } else {
      navigate(next ?? "/rider/portal");
    }
  }, [isAuthenticated, fromRegister, navigate, next]);

  const forgotMutation = useMutation({
    mutationFn: () => riderApi.forgotPassword(loginEmail.trim()),
    onSuccess: () => setForgotSent(loginEmail.trim()),
  });

  const loginMutation = useMutation({
    mutationFn: () => riderApi.login(loginEmail, loginPassword),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["rider-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["rider-auth-me"] });
    },
  });

  const registerMutation = useMutation({
    mutationFn: () => {
      if (regPassword !== regConfirm) throw new Error("Passwords do not match");
      return riderApi.register(regEmail, regPassword);
    },
    onSuccess: () => {
      setFromRegister(true);
      queryClient.removeQueries({ queryKey: ["rider-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["rider-auth-me"] });
    },
  });

  return (
    <div>
      <TitleBand
        containerClassName="max-w-5xl"
        eyebrow="Riders"
        title="Rider Portal"
        subtitle="Sign in to see your race history, results, upcoming races and RM Cash."
      >
        <div className="flex md:justify-end">
          <RmCashWidget isAuthenticated={isAuthenticated} />
        </div>
      </TitleBand>
      <div className="brand-form w-full max-w-md mx-auto px-4 py-10">
        <Tabs defaultValue="login" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-6 h-auto p-1 bg-[#F2F2F2] rounded-full">
            <TabsTrigger value="login" className="min-h-[44px] rounded-full font-heading font-bold uppercase tracking-[0.5px] text-[15px] text-[#555] data-[state=active]:bg-[#242424] data-[state=active]:text-white">Sign In</TabsTrigger>
            <TabsTrigger value="register" className="min-h-[44px] rounded-full font-heading font-bold uppercase tracking-[0.5px] text-[15px] text-[#555] data-[state=active]:bg-[#242424] data-[state=active]:text-white">Create Account</TabsTrigger>
          </TabsList>

          <TabsContent value="login">
            {forgotMode ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-heading font-extrabold uppercase text-[22px] text-[#242424] flex items-center gap-2">
                  <KeyRound size={20} /> Reset Password
                </CardTitle>
                <CardDescription className="text-[15px] leading-[1.6]">
                  We'll email you a link to choose a new password.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {forgotSent ? (
                  <div className="space-y-4">
                    <p className="flex items-start gap-2 text-[15px] leading-[1.6] text-[#242424]">
                      <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-[#1A8409]" />
                      If an account exists for {forgotSent}, we've emailed a reset link. It expires in 1 hour.
                    </p>
                    <Button type="button" variant="outline" className="w-full min-h-[52px]"
                      onClick={() => { setForgotMode(false); setForgotSent(null); }}>
                      Back to Sign In
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={(e) => { e.preventDefault(); forgotMutation.mutate(); }} className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="forgot-email">Email address</Label>
                      <div className="relative">
                        <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#555]" />
                        <Input id="forgot-email" type="email" placeholder="you@example.com" className="pl-10"
                          value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required />
                      </div>
                    </div>
                    {forgotMutation.error && (
                      <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-md px-3 py-2">
                        <AlertCircle size={14} />
                        {(forgotMutation.error as Error).message}
                      </div>
                    )}
                    <Button type="submit" className="w-full min-h-[52px] text-base bg-[#242424] border-[#242424] text-white hover:bg-black" disabled={forgotMutation.isPending}>
                      {forgotMutation.isPending ? "Sending…" : "Email Me a Reset Link"}
                    </Button>
                    <button type="button" onClick={() => setForgotMode(false)} className="w-full text-center text-[15px] font-medium text-[#333] underline underline-offset-2">
                      Back to Sign In
                    </button>
                  </form>
                )}
              </CardContent>
            </Card>
            ) : (
            <Card>
              <CardHeader>
                <CardTitle className="font-heading font-extrabold uppercase text-[22px] text-[#242424] flex items-center gap-2">
                  <LogIn size={20} /> Sign In
                </CardTitle>
                <CardDescription className="text-[15px] leading-[1.6]">
                  Access your race history and results
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => { e.preventDefault(); loginMutation.mutate(); }}
                  className="space-y-4"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="login-email">Email address</Label>
                    <div className="relative">
                      <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#555]" />
                      <Input
                        id="login-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-10"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="login-password">Password</Label>
                    <div className="relative">
                      <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#555]" />
                      <Input
                        id="login-password"
                        type="password"
                        placeholder="••••••••"
                        className="pl-10"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        required
                      />
                    </div>
                    <div className="flex justify-end">
                      <button type="button" onClick={() => { setForgotMode(true); setForgotSent(null); }}
                        className="text-[14px] font-medium text-[#333] underline underline-offset-2 hover:text-[#B30000]">
                        Forgot password?
                      </button>
                    </div>
                  </div>
                  {loginMutation.error && (
                    <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-md px-3 py-2">
                      <AlertCircle size={14} />
                      {(loginMutation.error as Error).message}
                    </div>
                  )}
                  <Button type="submit" className="w-full min-h-[52px] text-base bg-[#242424] border-[#242424] text-white hover:bg-black" disabled={loginMutation.isPending}>
                    {loginMutation.isPending ? "Signing in…" : "Sign In"}
                  </Button>
                </form>
              </CardContent>
            </Card>
            )}
          </TabsContent>

          <TabsContent value="register">
            <Card>
              <CardHeader>
                <CardTitle className="font-heading font-extrabold uppercase text-[22px] text-[#242424] flex items-center gap-2">
                  <UserPlus size={20} /> Create Account
                </CardTitle>
                <CardDescription className="text-[15px] leading-[1.6]">
                  Use the same email you register for events with — your race history will link automatically
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => { e.preventDefault(); registerMutation.mutate(); }}
                  className="space-y-4"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-email">Email address</Label>
                    <div className="relative">
                      <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#555]" />
                      <Input
                        id="reg-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-10"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-password">Password</Label>
                    <div className="relative">
                      <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#555]" />
                      <Input
                        id="reg-password"
                        type="password"
                        placeholder="At least 8 characters"
                        className="pl-10"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-confirm">Confirm password</Label>
                    <div className="relative">
                      <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#555]" />
                      <Input
                        id="reg-confirm"
                        type="password"
                        placeholder="••••••••"
                        className="pl-10"
                        value={regConfirm}
                        onChange={(e) => setRegConfirm(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  {registerMutation.error && (
                    <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-md px-3 py-2">
                      <AlertCircle size={14} />
                      {(registerMutation.error as Error).message}
                    </div>
                  )}
                  <Button type="submit" className="w-full min-h-[52px] text-base bg-[#242424] border-[#242424] text-white hover:bg-black" disabled={registerMutation.isPending}>
                    {registerMutation.isPending ? "Creating account…" : "Create Account"}
                  </Button>
                </form>
                <p className="mt-4 text-[13px] text-muted-foreground text-center">
                  Already registered for an event? Just use that email address — your history will appear automatically.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

      </div>
    </div>
  );
}
