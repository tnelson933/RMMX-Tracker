import { useState, useEffect, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Lock, Eye, EyeOff, AlertCircle, CheckCircle2, ArrowRight, Clock, BarChart2, Bell, Loader2 } from "lucide-react";
import { riderApi } from "@/lib/rider-api";
import { useRiderAuth } from "@/contexts/RiderAuthContext";

// The rider app's sign-in screen (rider-app/app/login.tsx): dark race theme, the
// RM Roost banner, "Race day starts here", feature chips, a Sign In / Create
// Account pill toggle and the red "Let's ride" button.

type Mode = "login" | "register" | "forgot";

function Field({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-[#3A3A3A] bg-[#1c1c1c] px-4 min-h-[56px] focus-within:border-[#FAFAFA]">
      <span className="text-[#A8A8A8] shrink-0">{icon}</span>
      {children}
    </div>
  );
}

const inputCls = "flex-1 min-w-0 bg-transparent text-[16px] text-white placeholder:text-[#8A8A8A] outline-none py-3";

function ErrorLine({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-[rgba(239,68,68,0.15)] text-[#ffb4b4] text-[14px] px-3 py-2.5">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function PrimaryButton({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="w-full min-h-[56px] rounded-full bg-[#B30000] text-white font-heading font-extrabold uppercase tracking-[1px] text-[18px] flex items-center justify-center gap-2 hover:bg-[#990000] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
    >
      {busy ? <Loader2 size={20} className="animate-spin" /> : children}
    </button>
  );
}

export default function RiderLogin() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useRiderAuth();
  const search = useSearch();

  // ?forgot=1 (from an expired reset link) opens straight to the reset form.
  const [mode, setMode] = useState<Mode>(() => new URLSearchParams(search).get("forgot") === "1" ? "forgot" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [forgotSent, setForgotSent] = useState<string | null>(null);
  // true after a successful registration: open the new rider's profile to fill in.
  const [fromRegister, setFromRegister] = useState(false);

  // The page a signed-out rider was trying to open (only rider pages).
  const nextParam = new URLSearchParams(search).get("next");
  const next = nextParam && nextParam.startsWith("/rider/") && !nextParam.startsWith("//") && !nextParam.startsWith("/rider/login") ? nextParam : null;

  useEffect(() => {
    if (!isAuthenticated) return;
    if (fromRegister) {
      riderApi.profiles().then(profiles => {
        navigate(profiles.length === 1 ? `/rider/portal/${profiles[0].id}?tab=profile` : "/rider/portal");
      }).catch(() => navigate("/rider/portal"));
    } else {
      navigate(next ?? "/rider/home");
    }
  }, [isAuthenticated, fromRegister, navigate, next]);

  const afterAuth = () => {
    queryClient.removeQueries({ queryKey: ["rider-profiles"] });
    queryClient.invalidateQueries({ queryKey: ["rider-auth-me"] });
  };

  const loginMutation = useMutation({
    mutationFn: () => riderApi.login(email.trim(), password),
    onSuccess: afterAuth,
  });
  const registerMutation = useMutation({
    mutationFn: () => {
      if (password !== confirm) throw new Error("The two passwords don't match. Type the same password in both boxes.");
      return riderApi.register(email.trim(), password);
    },
    onSuccess: () => { setFromRegister(true); afterAuth(); },
  });
  const forgotMutation = useMutation({
    mutationFn: () => riderApi.forgotPassword(email.trim()),
    onSuccess: () => setForgotSent(email.trim()),
  });

  const switchMode = (m: Mode) => {
    setMode(m);
    loginMutation.reset(); registerMutation.reset(); forgotMutation.reset();
    setForgotSent(null);
  };

  const active = mode === "login" ? loginMutation : registerMutation;
  const error = mode === "forgot" ? forgotMutation.error : active.error;

  return (
    <div className="rider-theme min-h-screen flex flex-col relative overflow-hidden">
      {/* Race stripes behind the banner, like the app's sign-in screen. */}
      <div aria-hidden className="pointer-events-none absolute -top-24 -left-1/4 w-[150%] h-[260px] -rotate-[8deg] bg-[linear-gradient(180deg,transparent_0,transparent_40%,rgba(179,0,0,0.55)_40%,rgba(179,0,0,0.55)_46%,transparent_46%,transparent_58%,rgba(255,255,255,0.08)_58%,rgba(255,255,255,0.08)_60%,transparent_60%)]" />

      <div className="relative flex-1 w-full max-w-[460px] mx-auto px-5 pt-8 pb-16 flex flex-col items-center">
        <img src="/brand/rm-roost-hero.png" alt="RM Roost" className="w-full max-w-[400px] h-auto" />

        <h1 className="mt-5 text-center font-heading font-extrabold uppercase text-[32px] sm:text-[36px] leading-[1.05] tracking-[1px] text-white">
          Race day starts here
        </h1>
        <p className="mt-2 text-center text-[16px] leading-[1.5] text-[#C8C8C8]">
          Live timing, results and race-day alerts for every event you enter.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-1.5 sm:gap-2">
          {([[Clock, "Live timing"], [BarChart2, "Results & stats"], [Bell, "Race alerts"]] as const).map(([Icon, label]) => (
            <span key={label} className="flex items-center gap-1.5 rounded-full border border-[#3A3A3A] bg-[#242424] pl-1 sm:pl-1.5 pr-2 sm:pr-3 py-1 sm:py-1.5 text-[12px] sm:text-[13px] font-bold text-white whitespace-nowrap">
              <span className="w-6 h-6 rounded-full bg-[#B30000] flex items-center justify-center"><Icon size={13} /></span>
              {label}
            </span>
          ))}
        </div>

        <div className="mt-7 w-full rounded-2xl border border-[#3A3A3A] bg-[#242424]/95 p-5 sm:p-6 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          {mode === "forgot" ? (
            <div className="space-y-4">
              <div>
                <h2 className="font-heading font-extrabold uppercase text-[22px] text-white">Forgot your password?</h2>
                <p className="text-[15px] text-[#A8A8A8] mt-1">We'll email you a link to set a new one.</p>
              </div>
              {forgotSent ? (
                <p className="flex items-start gap-2 text-[15px] leading-[1.6] text-white">
                  <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-[#22c55e]" />
                  If an account exists for {forgotSent}, we've emailed a reset link. It expires in 1 hour.
                </p>
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); forgotMutation.mutate(); }} className="space-y-4">
                  <Field icon={<Mail size={16} />}>
                    <input aria-label="Email address" type="email" autoComplete="email" placeholder="Email address" className={inputCls}
                      value={email} onChange={(e) => setEmail(e.target.value)} required />
                  </Field>
                  {error && <ErrorLine message={(error as Error).message} />}
                  <PrimaryButton busy={forgotMutation.isPending} disabled={!email.trim()}>Send Reset Link</PrimaryButton>
                </form>
              )}
              <button type="button" onClick={() => switchMode("login")} className="w-full text-center min-h-[44px] text-[15px] font-bold text-white hover:underline underline-offset-2">
                ← Back to Sign In
              </button>
            </div>
          ) : (
            <>
              <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 gap-1 p-1 rounded-full bg-[#161616] border border-[#2E2E2E]">
                {([["login", "Sign In"], ["register", "Create Account"]] as const).map(([m, label]) => (
                  <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => switchMode(m)}
                    className={`min-h-[48px] rounded-full font-heading font-bold text-[16px] transition-colors ${mode === m ? "bg-[#B30000] text-white" : "text-[#A8A8A8] hover:text-white"}`}>
                    {label}
                  </button>
                ))}
              </div>

              <form
                onSubmit={(e) => { e.preventDefault(); (mode === "login" ? loginMutation : registerMutation).mutate(); }}
                className="mt-5 space-y-3"
              >
                <Field icon={<Mail size={16} />}>
                  <input aria-label="Email address" type="email" autoComplete="email" placeholder="Email address" className={inputCls}
                    value={email} onChange={(e) => setEmail(e.target.value)} required />
                </Field>
                <Field icon={<Lock size={16} />}>
                  <input aria-label="Password" type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"}
                    placeholder={mode === "login" ? "Password" : "Password (at least 8 characters)"} className={inputCls}
                    value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? "Hide password" : "Show password"}
                    className="text-[#A8A8A8] hover:text-white w-9 h-9 flex items-center justify-center">
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </Field>
                {mode === "register" && (
                  <Field icon={<Lock size={16} />}>
                    <input aria-label="Confirm password" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Confirm password" className={inputCls}
                      value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                  </Field>
                )}
                {mode === "login" && (
                  <div className="flex justify-end">
                    <button type="button" onClick={() => switchMode("forgot")} className="min-h-[36px] text-[14px] font-bold text-white underline underline-offset-2">
                      Forgot password?
                    </button>
                  </div>
                )}
                {error && <ErrorLine message={(error as Error).message} />}
                <div className="pt-1">
                  <PrimaryButton busy={active.isPending} disabled={!email.trim() || !password || (mode === "register" && !confirm)}>
                    {mode === "login" ? "Let's Ride" : "Create Account"} <ArrowRight size={19} />
                  </PrimaryButton>
                </div>
              </form>
              <p className="mt-4 text-center text-[14px] leading-[1.55] text-[#A8A8A8]">
                {mode === "login"
                  ? "Use the email you register for races with to see your schedule, laps and results."
                  : "Use the email you register for races with. Every rider registered under it, your whole family included, links to this account."}
              </p>
            </>
          )}
        </div>

        <div className="mt-6 text-[12px] font-bold uppercase tracking-[2px] text-[#707070]">Rocky Mountain ATV/MC</div>
        <div className="mt-3 flex gap-4 text-[13px] text-[#A8A8A8]">
          <Link href="/" className="hover:text-white underline-offset-2 hover:underline">RM Roost home</Link>
          <Link href="/results" className="hover:text-white underline-offset-2 hover:underline">Race results</Link>
          <Link href="/rider-app" className="hover:text-white underline-offset-2 hover:underline">Get the app</Link>
        </div>
      </div>
      {/* Checkered strip along the bottom, as on the app. */}
      <div aria-hidden className="h-6 w-full opacity-[0.12] bg-[length:24px_24px] bg-[conic-gradient(#fff_25%,transparent_0_50%,#fff_0_75%,transparent_0)]" />
    </div>
  );
}
