import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { CheckCircle2, AlertCircle, Lock, Eye, EyeOff, Loader2 } from "lucide-react";

// Same dark sign-in look as RiderLogin (rider-app/app/login.tsx): race stripes,
// the RM Roost banner and a dark card with the red pill button.

function Field({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-[#3A3A3A] bg-[#1c1c1c] px-4 min-h-[56px] focus-within:border-[#FAFAFA]">
      <span className="text-[#A8A8A8] shrink-0"><Lock size={16} /></span>
      {children}
    </div>
  );
}

const inputCls = "flex-1 min-w-0 bg-transparent text-[16px] text-white placeholder:text-[#8A8A8A] outline-none py-3";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="rider-theme min-h-screen flex flex-col relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute -top-24 -left-1/4 w-[150%] h-[260px] -rotate-[8deg] bg-[linear-gradient(180deg,transparent_0,transparent_40%,rgba(179,0,0,0.55)_40%,rgba(179,0,0,0.55)_46%,transparent_46%,transparent_58%,rgba(255,255,255,0.08)_58%,rgba(255,255,255,0.08)_60%,transparent_60%)]" />
      <div className="relative flex-1 w-full max-w-[460px] mx-auto px-5 pt-8 pb-16 flex flex-col items-center">
        <img src="/brand/rm-roost-hero.png" alt="RM Roost" className="w-full max-w-[360px] h-auto" />
        <div className="mt-7 w-full rounded-2xl border border-[#3A3A3A] bg-[#242424]/95 p-5 sm:p-6 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          {children}
        </div>
        <div className="mt-6 text-[12px] font-bold uppercase tracking-[2px] text-[#8A8A8A]">Rocky Mountain ATV/MC</div>
      </div>
      <div aria-hidden className="h-6 w-full opacity-[0.12] bg-[length:24px_24px] bg-[conic-gradient(#fff_25%,transparent_0_50%,#fff_0_75%,transparent_0)]" />
    </div>
  );
}

const primaryBtn = "w-full min-h-[56px] rounded-full bg-[#B30000] text-white font-heading font-extrabold uppercase tracking-[1px] text-[18px] flex items-center justify-center gap-2 hover:bg-[#990000] disabled:opacity-45 disabled:cursor-not-allowed transition-colors";

export default function ResetRiderPassword() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setErrorMsg("Passwords don't match."); setStatus("error"); return; }
    if (password.length < 8) { setErrorMsg("Password must be at least 8 characters."); setStatus("error"); return; }
    setStatus("loading");
    setErrorMsg("");
    try {
      const res = await fetch("/api/rider/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error ?? "Something went wrong."); setStatus("error"); }
      else setStatus("success");
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  }

  if (!token) {
    return (
      <Shell>
        <div className="text-center space-y-3">
          <AlertCircle className="w-11 h-11 text-[#ffb4b4] mx-auto" />
          <h1 className="font-heading font-extrabold uppercase text-[26px] text-white">Invalid Link</h1>
          <p className="text-[15px] text-[#A8A8A8] leading-[1.6]">This password reset link is missing or malformed. Please request a new one.</p>
          <Link href="/rider/login?forgot=1" className={`${primaryBtn} mt-2`}>Request a new link</Link>
        </div>
      </Shell>
    );
  }

  if (status === "success") {
    return (
      <Shell>
        <div className="text-center space-y-3">
          <CheckCircle2 className="w-11 h-11 text-[#22c55e] mx-auto" />
          <h1 className="font-heading font-extrabold uppercase text-[26px] text-white">Password Updated</h1>
          <p className="text-[15px] text-[#A8A8A8] leading-[1.6]">Your password has been reset. Sign in to the RM Roost app or the website with your new password.</p>
          <Link href="/rider/login" className={`${primaryBtn} mt-2`}>Sign In</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-4">
        <div>
          <div className="text-[12px] font-bold uppercase tracking-[1.5px] text-[#A8A8A8] mb-1">Rider account</div>
          <h1 className="font-heading font-extrabold uppercase text-[26px] text-white leading-[1.05]">Reset Password</h1>
          <p className="text-[15px] text-[#A8A8A8] mt-1">Choose a new password for your RM Roost rider account.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field>
            <input id="password" aria-label="New password" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={8}
              placeholder="New password (at least 8 characters)" className={inputCls} value={password} onChange={e => setPassword(e.target.value)} />
            <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? "Hide password" : "Show password"}
              className="text-[#A8A8A8] hover:text-white w-9 h-9 flex items-center justify-center">
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </Field>
          <Field>
            <input id="confirm" aria-label="Confirm new password" type={showPassword ? "text" : "password"} autoComplete="new-password" required
              placeholder="Repeat your new password" className={inputCls} value={confirm} onChange={e => setConfirm(e.target.value)} />
          </Field>

          {status === "error" && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-[rgba(239,68,68,0.15)] text-[#ffb4b4] text-[14px] px-3 py-2.5">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>
                {errorMsg}
                {/expired|invalid|incomplete/i.test(errorMsg) && (
                  <> <a href="/rider/login?forgot=1" className="font-semibold text-white underline underline-offset-2">Request a new link</a></>
                )}
              </span>
            </div>
          )}

          <div className="pt-1">
            <button type="submit" className={primaryBtn} disabled={status === "loading" || !password || !confirm}>
              {status === "loading" ? <Loader2 size={20} className="animate-spin" /> : "Set New Password"}
            </button>
          </div>
        </form>
      </div>
    </Shell>
  );
}
