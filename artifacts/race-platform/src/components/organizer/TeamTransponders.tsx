import { useEffect, useState } from "react";
import { AlertCircle, Banknote, CreditCard, Loader2, Minus, Plus, Save } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CashTender } from "@/components/organizer/CashTender";
import { CardPaymentPanel, type CardStarted, type CardStartOptions } from "@/components/payments/CardPaymentPanel";
import { responseErrorMessage } from "@/lib/friendlyErrors";
import { RM_TRACKR_NAME } from "@/lib/rmTrackr";
import { useToast } from "@/hooks/use-toast";

interface TeamMember {
  id: number;
  position: number;
  firstName: string;
  lastName: string;
  email: string | null;
  rfidNumber: string | null;
  trackrNumber: string | null;
  /** Chosen at registration: "own", "rent" or "buy". */
  trackrChoice?: string | null;
  rfidPurchased?: boolean;
}

type SaleItem = "rfid" | "trackr" | "rental";
const SALE: Record<SaleItem, { action: string; verify: string; label: string; amountKey: string }> = {
  rental: { action: "add-transponder-rental", verify: "verify-transponder-rental", label: "Transponder rental", amountKey: "rentalFee" },
  rfid: { action: "add-rfid-sticker", verify: "verify-rfid-sticker", label: "RFID tag", amountKey: "stickerFee" },
  trackr: { action: "add-rm-trackr", verify: "verify-rm-trackr", label: RM_TRACKR_NAME, amountKey: "price" },
};

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Group race check-in: every team member's RFID tag and/or RM TrackR number,
 * plus selling the team as many tags as it needs (one per rider at most per sale).
 */
export function TeamTranspondersDialog({ eventId, registrationId, teamName, ridersPerGroup, rfidPrice, trackrPrice, rentalPrice, onClose, onChanged }: {
  eventId: number;
  /** null closes the dialog. */
  registrationId: number | null;
  teamName: string | null;
  ridersPerGroup: number;
  /** Price per tag, or null when it isn't sold at this event. */
  rfidPrice: number | null;
  trackrPrice: number | null;
  rentalPrice: number | null;
  onClose: () => void;
  /** Something was saved or sold: refresh check-in. */
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const priceOf = (i: SaleItem) => (i === "rfid" ? rfidPrice : i === "trackr" ? trackrPrice : rentalPrice);
  const sellable = (["trackr", "rental", "rfid"] as SaleItem[]).filter(i => priceOf(i) != null);
  const [item, setItem] = useState<SaleItem>(sellable[0] ?? "rfid");
  const [qty, setQty] = useState(1);
  const [saleStep, setSaleStep] = useState<"pick" | "cash" | "card">("pick");
  const [saleBusy, setSaleBusy] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [card, setCard] = useState<(CardStarted & { regId: number }) | null>(null);

  const open = registrationId != null;
  const unit = priceOf(item);
  const total = Math.round((unit ?? 0) * qty * 100) / 100;

  useEffect(() => {
    if (!open) return;
    setMembers(null); setLoadError(null); setSaveError(null);
    setSaleStep("pick"); setSaleError(null); setCard(null); setQty(1);
    setItem(sellable[0] ?? "rfid");
    let cancelled = false;
    fetch(`/api/events/${eventId}/registrations/${registrationId}/team`)
      .then(async res => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(responseErrorMessage(res.status, json));
        if (!cancelled) setMembers(json.members ?? []);
      })
      .catch(e => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, registrationId, eventId]);

  // Card payment: wait for Stripe to confirm it.
  useEffect(() => {
    if (saleStep !== "card" || !card) return;
    let stopped = false;
    (async () => {
      while (!stopped) {
        await new Promise(r => setTimeout(r, 3000));
        if (stopped) break;
        try {
          const res = await fetch(`/api/public/registrations/${card.regId}/${SALE[item].verify}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: card.sessionId }),
          });
          if (res.ok) {
            stopped = true;
            toast({ title: `${qty} × ${SALE[item].label} paid`, description: `${money(total)} collected by card. Enter each rider's number below.` });
            onChanged();
            setSaleStep("pick"); setCard(null); setQty(1);
          }
        } catch { /* keep polling */ }
      }
    })();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleStep, card]);

  const setField = (id: number, patch: Partial<TeamMember>) =>
    setMembers(prev => prev?.map(m => (m.id === id ? { ...m, ...patch } : m)) ?? prev);

  const save = async () => {
    if (!members || registrationId == null) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${registrationId}/team`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: members.map(m => ({ id: m.id, rfidNumber: m.rfidNumber ?? "", trackrNumber: m.trackrNumber ?? "" })) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || responseErrorMessage(res.status, json));
      setMembers(json.members);
      onChanged();
      const withNumbers = (json.members as TeamMember[]).filter(m => m.rfidNumber || m.trackrNumber).length;
      toast({ title: "Team numbers saved", description: `${withNumbers} of ${json.members.length} riders have a number.` });
      onClose();
    } catch (e: any) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const sellCash = async (cashTendered: number) => {
    if (registrationId == null) return;
    setSaleBusy(true); setSaleError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${registrationId}/${SALE[item].action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethod: "cash", quantity: qty, cashTendered }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || responseErrorMessage(res.status, json));
      const paid = Number(json[SALE[item].amountKey] ?? total);
      toast({ title: `${qty} × ${SALE[item].label} sold`, description: `${money(paid)} collected in cash${json.cashChange ? `, ${money(Number(json.cashChange))} change given` : ""}. Enter each rider's number below.` });
      onChanged();
      setSaleStep("pick"); setQty(1);
    } catch (e: any) {
      setSaleError(e.message);
    } finally {
      setSaleBusy(false);
    }
  };

  const startCard = async (opts: CardStartOptions) => {
    if (registrationId == null) return;
    const res = await fetch(`/api/events/${eventId}/registrations/${registrationId}/${SALE[item].action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.readerId
        ? { paymentMethod: "reader", readerId: opts.readerId, quantity: qty }
        : { paymentMethod: "card", embedded: !!opts.embedded, quantity: qty }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || responseErrorMessage(res.status, json));
    setCard({ ...json, regId: registrationId });
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-heading uppercase tracking-wide">Team transponder numbers</DialogTitle>
          {teamName && <p className="text-sm text-muted-foreground">Team {teamName} · {ridersPerGroup} riders</p>}
        </DialogHeader>

        {/* ── Buy tags for the team ── */}
        {sellable.length > 0 && (
          <div className="rounded-lg border p-4 space-y-3">
            <p className="text-sm font-heading font-semibold uppercase tracking-wide">Buy tags for the team</p>
            {saleStep === "pick" && (
              <>
                <div className="flex flex-wrap gap-2">
                  {sellable.map(i => (
                    <Button key={i} type="button" size="sm" variant={item === i ? "default" : "outline"} onClick={() => setItem(i)}>
                      {SALE[i].label} · {money(priceOf(i) ?? 0)} each
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm">How many</span>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label="One fewer" disabled={qty <= 1} onClick={() => setQty(q => Math.max(1, q - 1))}><Minus size={14} /></Button>
                    <span className="w-8 text-center font-mono text-lg" aria-live="polite">{qty}</span>
                    <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label="One more" disabled={qty >= ridersPerGroup} onClick={() => setQty(q => Math.min(ridersPerGroup, q + 1))}><Plus size={14} /></Button>
                  </div>
                  <span className="ml-auto text-lg font-heading font-bold">Total {money(total)}</span>
                </div>
                {saleError && <p className="text-sm text-destructive">{saleError}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" className="gap-1.5" onClick={() => { setSaleError(null); setSaleStep("cash"); }}>
                    <Banknote size={16} /> Cash
                  </Button>
                  <Button type="button" variant="outline" className="gap-1.5" onClick={() => { setSaleError(null); setCard(null); setSaleStep("card"); }}>
                    <CreditCard size={16} /> Card
                  </Button>
                </div>
              </>
            )}
            {saleStep === "cash" && (
              <>
                <p className="text-sm text-muted-foreground">{qty} × {SALE[item].label}</p>
                <CashTender due={total} busy={saleBusy} error={saleError} onConfirm={sellCash} onBack={() => setSaleStep("pick")} />
              </>
            )}
            {saleStep === "card" && (
              <>
                <p className="text-sm text-muted-foreground">{qty} × {SALE[item].label}</p>
                <CardPaymentPanel eventId={eventId} amount={total} current={card} start={startCard} onCancel={() => { setSaleStep("pick"); setCard(null); }} />
              </>
            )}
          </div>
        )}

        {/* ── Each rider's numbers ── */}
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Enter each rider's RFID tag and/or {RM_TRACKR_NAME} number. A read of any of them counts as a lap for the team.
          </p>
          {loadError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
              <AlertCircle size={16} className="flex-shrink-0" /> {loadError}
            </div>
          )}
          {!members && !loadError && <div className="flex justify-center py-6"><Loader2 className="animate-spin text-muted-foreground" /></div>}
          {members?.length === 0 && <p className="text-sm text-muted-foreground">This team has no riders on file. It was registered before the event became a group race.</p>}
          {members?.map(m => (
            <div key={m.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-semibold">
                  Rider {m.position}: {m.firstName} {m.lastName}
                  {m.position === 1 && <span className="ml-1 text-xs text-muted-foreground font-normal">(captain)</span>}
                </p>
                {m.email && <p className="text-xs text-muted-foreground truncate">{m.email}</p>}
              </div>
              {(m.trackrChoice === "rent" || m.trackrChoice === "buy" || m.rfidPurchased) && (
                <div className="flex flex-wrap gap-1.5">
                  {m.trackrChoice === "rent" && <span className="text-xs font-semibold rounded border border-amber-300 bg-amber-50 text-amber-800 px-2 py-0.5">Renting a transponder: hand one out and enter its number</span>}
                  {m.trackrChoice === "buy" && <span className="text-xs font-semibold rounded border border-amber-300 bg-amber-50 text-amber-800 px-2 py-0.5">Bought an {RM_TRACKR_NAME}: hand one out and enter its number</span>}
                  {m.rfidPurchased && <span className="text-xs font-semibold rounded border border-amber-300 bg-amber-50 text-amber-800 px-2 py-0.5">Bought an RFID tag: stick one on and enter its number</span>}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">RFID tag</span>
                  <Input value={m.rfidNumber ?? ""} placeholder="Scan or type" className="font-mono" onChange={e => setField(m.id, { rfidNumber: e.target.value })} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">{RM_TRACKR_NAME} number</span>
                  <Input value={m.trackrNumber ?? ""} placeholder="ID on the transponder" className="font-mono uppercase" onChange={e => setField(m.id, { trackrNumber: e.target.value })} />
                </label>
              </div>
            </div>
          ))}
          {saveError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
              <AlertCircle size={16} className="flex-shrink-0" /> {saveError}
            </div>
          )}
          <div className="flex gap-3">
            <Button type="button" variant="outline" className="flex-1 font-heading uppercase" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="button" className="flex-1 font-heading uppercase gap-1.5" onClick={save} disabled={saving || !members || members.length === 0}>
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save numbers
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
