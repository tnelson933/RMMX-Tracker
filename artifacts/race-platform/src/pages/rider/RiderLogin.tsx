import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mountain, Mail, Lock, UserPlus, LogIn, AlertCircle, Zap } from "lucide-react";
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
      navigate("/rider/portal");
    }
  }, [isAuthenticated, fromRegister, navigate]);

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
    <div className="min-h-screen h-screen overflow-y-auto hide-scrollbar bg-background flex flex-col items-center justify-center p-4">
      {/* RM Cash — always top-right */}
      <div className="fixed top-4 right-4 flex items-center gap-1.5 bg-muted border border-border rounded-lg px-2.5 py-1.5 select-none z-50">
        <Zap size={11} className="text-green-600 fill-green-600" />
        <div className="flex flex-col leading-none">
          <span className="text-[8px] font-bold uppercase tracking-widest text-muted-foreground">RM Cash</span>
          <span className="text-sm font-extrabold text-green-600">$0.00</span>
        </div>
      </div>

      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-3 mb-8">
          <Mountain size={32} className="text-primary" />
          <div>
            <h1 className="font-heading font-bold text-2xl uppercase tracking-wider leading-none">RM Tracker</h1>
            <p className="text-muted-foreground text-sm">Rider Portal</p>
          </div>
        </div>

        <Tabs defaultValue="login" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="login" className="font-heading uppercase tracking-wider text-xs">Sign In</TabsTrigger>
            <TabsTrigger value="register" className="font-heading uppercase tracking-wider text-xs">Create Account</TabsTrigger>
          </TabsList>

          <TabsContent value="login">
            <Card>
              <CardHeader>
                <CardTitle className="font-heading uppercase tracking-wider text-lg flex items-center gap-2">
                  <LogIn size={18} className="text-primary" /> Sign In
                </CardTitle>
                <CardDescription>
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
                      <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="login-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-9"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="login-password">Password</Label>
                    <div className="relative">
                      <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="login-password"
                        type="password"
                        placeholder="••••••••"
                        className="pl-9"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  {loginMutation.error && (
                    <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-md px-3 py-2">
                      <AlertCircle size={14} />
                      {(loginMutation.error as Error).message}
                    </div>
                  )}
                  <Button type="submit" className="w-full font-heading uppercase tracking-wider" disabled={loginMutation.isPending}>
                    {loginMutation.isPending ? "Signing in…" : "Sign In"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="register">
            <Card>
              <CardHeader>
                <CardTitle className="font-heading uppercase tracking-wider text-lg flex items-center gap-2">
                  <UserPlus size={18} className="text-primary" /> Create Account
                </CardTitle>
                <CardDescription>
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
                      <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="reg-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-9"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-password">Password</Label>
                    <div className="relative">
                      <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="reg-password"
                        type="password"
                        placeholder="At least 8 characters"
                        className="pl-9"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-confirm">Confirm password</Label>
                    <div className="relative">
                      <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="reg-confirm"
                        type="password"
                        placeholder="••••••••"
                        className="pl-9"
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
                  <Button type="submit" className="w-full font-heading uppercase tracking-wider" disabled={registerMutation.isPending}>
                    {registerMutation.isPending ? "Creating account…" : "Create Account"}
                  </Button>
                </form>
                <p className="mt-4 text-xs text-muted-foreground text-center">
                  Already registered for an event? Just use that email address — your history will appear automatically.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          <a href="/" className="hover:underline">← Back to public site</a>
        </p>
      </div>
    </div>
  );
}
