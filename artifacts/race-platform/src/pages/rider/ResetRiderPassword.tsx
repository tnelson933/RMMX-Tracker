import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, AlertCircle, Feather } from "lucide-react";
import { TitleBand } from "@/components/TitleBand";

export default function ResetRiderPassword() {
  const [location] = useLocation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
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
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <AlertCircle className="w-12 h-12 text-primary mx-auto mb-4" />
        <h1 className="text-[28px] font-heading font-extrabold uppercase text-[#242424] mb-2">Invalid Link</h1>
        <p className="text-[#333] leading-[1.7]">This password reset link is missing or malformed. Please request a new one from the app.</p>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <CheckCircle className="w-12 h-12 text-[#1A8409] mx-auto mb-4" />
        <h1 className="text-[28px] font-heading font-extrabold uppercase text-[#242424] mb-2">Password Updated</h1>
        <p className="text-[#333] leading-[1.7]">Your password has been reset. Open the RM Roost app and sign in with your new password.</p>
      </div>
    );
  }

  return (
    <div>
      <TitleBand
        containerClassName="max-w-5xl"
        eyebrow="Rider account"
        title="Reset Password"
        subtitle="Choose a new password for your RM Roost rider account."
      />
      <div className="brand-form max-w-md mx-auto px-4 py-10">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <Input id="password" type="password" required minLength={8} placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input id="confirm" type="password" required placeholder="Repeat your new password" value={confirm} onChange={e => setConfirm(e.target.value)} />
        </div>

        {status === "error" && (
          <div className="flex items-start gap-2 text-sm text-primary bg-[#FEDEDE] rounded-[6px] p-3">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <Button type="submit" className="w-full min-h-[52px] text-base bg-[#242424] border-[#242424] text-white hover:bg-black" disabled={status === "loading"}>
          {status === "loading" ? "Updating…" : "Set New Password"}
        </Button>
      </form>
      </div>
    </div>
  );
}
