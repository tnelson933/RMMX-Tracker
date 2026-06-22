import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, Mail, ArrowLeft } from "lucide-react";
import rmLogo from "@assets/rm-logo.png";

export default function ForgotPassword() {
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

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-4 bg-sidebar/5 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl -z-10 pointer-events-none" />

      <Card className="w-full max-w-md shadow-2xl border-sidebar-border/20">
        <div className="bg-sidebar p-8 text-center border-b border-sidebar-border relative overflow-hidden">
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjMWExYTFhIj48L3JlY3Q+CjxwYXRoIGQ9Ik0wIDBMOCA4Wk04IDBMMCA4WiIgc3Ryb2tlPSIjMjI0IiBzdHJva2Utd2lkdGg9IjEiPjwvcGF0aD4KPC9zdmc+')] opacity-20" />
          <img src={rmLogo} alt="RM Tracker" className="w-16 h-16 mx-auto mb-4 relative z-10 drop-shadow-lg" />
          <h1 className="text-3xl font-heading font-bold uppercase tracking-tight text-sidebar-foreground relative z-10">
            Reset Password
          </h1>
          <p className="text-sidebar-foreground/70 mt-2 relative z-10 text-base">
            We'll send a reset link to your email
          </p>
        </div>

        <CardContent className="p-8">
          {sent ? (
            <div className="text-center space-y-4 py-4">
              <CheckCircle className="w-16 h-16 text-secondary mx-auto" />
              <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">Check Your Email</h2>
              <p className="text-muted-foreground max-w-sm mx-auto text-sm leading-relaxed">
                If <span className="font-semibold text-foreground">{email}</span> is associated with an account,
                you'll receive a password reset link shortly. It expires in 72 hours.
              </p>
              <Link href="/login">
                <Button variant="outline" className="mt-4 font-heading uppercase tracking-wider gap-2">
                  <ArrowLeft size={16} /> Back to Login
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <h2 className="text-xl font-heading font-bold uppercase tracking-tight mb-1">Forgot your password?</h2>
                <p className="text-muted-foreground text-sm">
                  Enter the email address on your organizer account and we'll send you a reset link.
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
                  <><Mail size={18} /> Send Reset Link</>
                )}
              </Button>

              <div className="text-center">
                <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  ← Back to login
                </Link>
              </div>
            </form>
          )}
        </CardContent>

        <CardFooter className="bg-muted/30 border-t p-6 text-center text-sm text-muted-foreground font-medium">
          Authorized personnel only. All access is logged.
        </CardFooter>
      </Card>
    </div>
  );
}
