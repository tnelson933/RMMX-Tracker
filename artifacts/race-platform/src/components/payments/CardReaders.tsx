import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StateSelect } from "@/components/ui/StateSelect";
import { useToast } from "@/hooks/use-toast";
import { errorText, responseErrorMessage } from "@/lib/friendlyErrors";
import { CreditCard, Loader2, Plus, Trash2, Wifi, WifiOff } from "lucide-react";
import { useStripeConfig } from "./EmbeddedCardForm";

interface Reader { id: string; label: string; deviceType: string; status: "online" | "offline"; serialNumber: string | null; simulated: boolean }

const READERS_KEY = ["/api/stripe/connect/readers"];

async function send(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method, credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(responseErrorMessage(res.status, json)), { body: json });
  return json;
}

/**
 * Payments page → Card readers: Stripe Terminal smart readers (WisePOS E,
 * S700) the club uses at check-in. Payments on them are paid out to the club
 * like online payments. Check-in's card button offers "Charge on <reader>"
 * once one is added and online.
 */
export function CardReaders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const stripe = useStripeConfig();
  const { data: readers = [], isLoading, isError, refetch } = useQuery<Reader[]>({
    queryKey: READERS_KEY,
    queryFn: () => send("GET", "/api/stripe/connect/readers"),
  });
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [needsAddress, setNeedsAddress] = useState(false);
  const [address, setAddress] = useState({ line1: "", city: "", state: "", postalCode: "" });
  const [busy, setBusy] = useState<string | null>(null);

  async function add() {
    setBusy("add");
    try {
      await send("POST", "/api/stripe/connect/readers", { registrationCode: code, label, ...(needsAddress ? { address } : {}) });
      toast({ title: "Card reader added", description: `${label || "The reader"} is ready for check-in.` });
      setCode(""); setLabel(""); setAdding(false); setNeedsAddress(false);
      await queryClient.invalidateQueries({ queryKey: READERS_KEY });
    } catch (err: any) {
      if (err?.body?.needsAddress) setNeedsAddress(true);
      toast({ title: "Couldn't add the reader", description: errorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: Reader) {
    if (!window.confirm(`Remove ${r.label}? You can add it again later with a new pairing code.`)) return;
    setBusy(r.id);
    try {
      await send("DELETE", `/api/stripe/connect/readers/${r.id}`);
      await queryClient.invalidateQueries({ queryKey: READERS_KEY });
    } catch (err) {
      toast({ title: "Couldn't remove the reader", description: errorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function rename(r: Reader, next: string) {
    if (!next.trim() || next.trim() === r.label) return;
    try {
      await send("PATCH", `/api/stripe/connect/readers/${r.id}`, { label: next.trim() });
      await queryClient.invalidateQueries({ queryKey: READERS_KEY });
    } catch (err) {
      toast({ title: "Couldn't rename the reader", description: errorText(err), variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 rounded-full p-3"><CreditCard size={22} className="text-primary" /></div>
          <div>
            <CardTitle className="font-heading uppercase">Card readers</CardTitle>
            <CardDescription>Optional. Take cards in person at check-in on a Stripe reader (tap, insert or swipe). Without one, staff type the card in the page or the rider pays on their phone.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError ? (
          <p className="text-sm text-muted-foreground">Couldn't load your card readers. <button className="underline" onClick={() => refetch()}>Try again</button></p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : readers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No card readers yet.</p>
        ) : (
          <div className="space-y-2">
            {readers.map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                {r.status === "online" ? <Wifi size={16} className="text-emerald-600" /> : <WifiOff size={16} className="text-muted-foreground" />}
                <Input defaultValue={r.label} className="h-8 w-48 text-sm font-semibold" aria-label={`Name of ${r.label}`} onBlur={e => rename(r, e.target.value)} />
                <span className={`text-xs font-semibold ${r.status === "online" ? "text-emerald-700" : "text-muted-foreground"}`}>{r.status === "online" ? "Online" : "Offline"}</span>
                <span className="text-xs text-muted-foreground">{r.simulated ? "Simulated (test mode)" : r.deviceType.replace(/_/g, " ")}{r.serialNumber && !r.simulated ? ` · ${r.serialNumber}` : ""}</span>
                <span className="flex-1" />
                {busy === r.id ? <Loader2 size={14} className="animate-spin" /> : (
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" aria-label={`Remove ${r.label}`} title="Remove reader" onClick={() => remove(r)}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {adding ? (
          <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              On the reader, open <strong>Settings → Generate pairing code</strong> and enter the code here.
              {stripe?.testMode && <> In test mode, enter <code className="font-mono">simulated-wpe</code> to add a simulated reader.</>}
            </p>
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="space-y-1"><Label htmlFor="reader-code">Pairing code</Label><Input id="reader-code" value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. sepia-cerulean-aardvark" /></div>
              <div className="space-y-1"><Label htmlFor="reader-label">Name</Label><Input id="reader-label" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Gate reader" maxLength={60} /></div>
            </div>
            {needsAddress && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Stripe needs your club's address for its first card reader.</p>
                <Input value={address.line1} onChange={e => setAddress(a => ({ ...a, line1: e.target.value }))} placeholder="Street address" aria-label="Street address" />
                <div className="grid grid-cols-2 gap-2">
                  <Input value={address.city} onChange={e => setAddress(a => ({ ...a, city: e.target.value }))} placeholder="City" aria-label="City" />
                  <Input value={address.postalCode} onChange={e => setAddress(a => ({ ...a, postalCode: e.target.value }))} placeholder="ZIP" aria-label="ZIP" />
                </div>
                <StateSelect value={address.state} onChange={v => setAddress(a => ({ ...a, state: v }))} placeholder="Select state…" />
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => { setAdding(false); setNeedsAddress(false); }} disabled={busy === "add"}>Cancel</Button>
              <Button onClick={add} disabled={busy === "add" || !code.trim()} className="gap-1.5">
                {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add reader
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="gap-1.5" onClick={() => setAdding(true)}><Plus size={14} /> Add a card reader</Button>
        )}
      </CardContent>
    </Card>
  );
}
