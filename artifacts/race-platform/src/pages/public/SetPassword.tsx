import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert, CheckCircle, KeyRound, Mail, ArrowLeft } from "lucide-react";

function RequestSetupForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError(null);
    try {
      await fetch("/api/auth/request-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="text-center space-y-4 py-4">
        <CheckCircle className="w-16 h-16 text-secondary mx-auto" />
        <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">Check Your Email</h2>
        <p className="text-muted-foreground max-w-sm mx-auto">
          If that email is associated with an account, we've sent a setup link. It expires in 72 hours.
        </p>
        <Link href="/login">
          <Button variant="outline" className="mt-4 font-heading uppercase tracking-wider gap-2">
            <ArrowLeft size={16} /> Back to Login
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <h2 className="text-2xl font-heading font-bold uppercase tracking-tight mb-1">First Time Sign In</h2>
        <p className="text-muted-foreground text-sm">
          Enter your email address and we'll send you a link to set up your password.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Email Address
        </label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="official@club.com"
          required
          className="h-12 bg-muted/50 text-lg font-medium"
          autoFocus
        />
      </div>

      <Button
        type="submit"
        disabled={loading || !email}
        className="w-full h-12 font-heading uppercase tracking-widest gap-2"
      >
        {loading ? (
          <><span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Sending...</>
        ) : (
          <><Mail size={18} /> Send Setup Link</>
        )}
      </Button>

      <div className="text-center">
        <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          ← Back to login
        </Link>
      </div>
    </form>
  );
}

function SetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/complete-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
      } else {
        setDone(true);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="text-center space-y-4 py-4">
        <CheckCircle className="w-16 h-16 text-secondary mx-auto" />
        <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">Password Set!</h2>
        <p className="text-muted-foreground">Your account is active. You can now sign in.</p>
        <Link href="/login">
          <Button className="mt-4 font-heading uppercase tracking-wider gap-2">
            <KeyRound size={16} /> Go to Login
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <h2 className="text-2xl font-heading font-bold uppercase tracking-tight mb-1">Set Your Password</h2>
        <p className="text-muted-foreground text-sm">Choose a strong password to activate your account.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">New Password</label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Minimum 8 characters"
          required
          className="h-12 bg-muted/50 font-mono tracking-widest text-lg"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Confirm Password</label>
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Repeat your password"
          required
          className="h-12 bg-muted/50 font-mono tracking-widest text-lg"
        />
      </div>

      <Button
        type="submit"
        disabled={loading || !password || !confirm}
        className="w-full h-12 font-heading uppercase tracking-widest gap-2"
      >
        {loading ? (
          <><span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Activating...</>
        ) : (
          <><KeyRound size={18} /> Activate Account</>
        )}
      </Button>
    </form>
  );
}

export default function SetPassword() {
  const token = new URLSearchParams(window.location.search).get("token");

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-4 bg-sidebar/5 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl -z-10 pointer-events-none" />

      <Card className="w-full max-w-md shadow-2xl border-sidebar-border/20">
        <div className="bg-sidebar p-8 text-center border-b border-sidebar-border relative overflow-hidden">
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjMWExYTFhIj48L3JlY3Q+CjxwYXRoIGQ9Ik0wIDBMOCA4Wk04IDBMMCA4WiIgc3Ryb2tlPSIjMjI0IiBzdHJva2Utd2lkdGg9IjEiPjwvcGF0aD4KPC9zdmc+')] opacity-20" />
          <ShieldAlert className="w-12 h-12 text-primary mx-auto mb-4 relative z-10" />
          <h1 className="text-3xl font-heading font-bold uppercase tracking-tight text-sidebar-foreground relative z-10">
            Organizer Portal
          </h1>
          <p className="text-sidebar-foreground/70 mt-2 relative z-10 text-base">
            {token ? "Activate your account" : "Account setup"}
          </p>
        </div>

        <CardContent className="p-8">
          {token ? <SetPasswordForm token={token} /> : <RequestSetupForm />}
        </CardContent>

        <CardFooter className="bg-muted/30 border-t p-6 text-center text-sm text-muted-foreground font-medium">
          Authorized personnel only. All access is logged.
        </CardFooter>
      </Card>
    </div>
  );
}
