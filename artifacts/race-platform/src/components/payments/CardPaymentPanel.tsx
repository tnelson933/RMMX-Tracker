import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { CreditCard, Keyboard, Loader2, Smartphone, Wifi, WifiOff, AlertCircle } from "lucide-react";
import { errorText, responseErrorMessage } from "@/lib/friendlyErrors";
import { EmbeddedCardForm, useStripeConfig } from "./EmbeddedCardForm";

/**
 * Taking a card at check-in, without leaving RM Roost:
 *  - Type card here: Stripe's form inside the dialog (default).
 *  - Card reader: the club's Stripe Terminal reader (Payments page) shows the
 *    amount; the rider taps, inserts or swipes.
 *  - Rider's phone: a QR code to Stripe's page on their own phone.
 * The dialog that shows this polls the payment and closes once it's paid.
 */

export interface CardStartOptions { embedded?: boolean; readerId?: string }
export interface CardStarted {
  sessionId: string;
  clientSecret?: string | null;
  checkoutUrl?: string | null;
  paymentIntentId?: string | null;
}
export interface CardReader { id: string; label: string; status: "online" | "offline"; simulated: boolean }

type Mode = "embedded" | "reader" | "phone";

export function useCardReaders(eventId: number) {
  return useQuery<CardReader[]>({
    queryKey: ["/api/events", eventId, "card-readers"],
    enabled: !!eventId,
    staleTime: 15_000,
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/card-readers`, { credentials: "include" });
      return res.ok ? res.json() : [];
    },
  });
}

export function CardPaymentPanel({ eventId, amount, current, start, onCancel }: {
  eventId: number;
  amount: number;
  /** The payment the dialog is watching (null before one is started). */
  current: CardStarted | null;
  /** Start (or restart) the payment a given way; the dialog stores the result and polls it. */
  start: (opts: CardStartOptions) => Promise<CardStarted | void>;
  onCancel: () => void;
}) {
  const { data: readers = [], isLoading: readersLoading } = useCardReaders(eventId);
  const stripeConfig = useStripeConfig();
  const onlineReaders = readers.filter(r => r.status === "online");
  const [mode, setMode] = useState<Mode | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readerLabel, setReaderLabel] = useState<string | null>(null);
  const begun = useRef(false);

  async function go(next: Mode, readerId?: string) {
    setError(null);
    setStarting(true);
    try {
      // Leaving a reader charge: take it off the reader first.
      if (current?.paymentIntentId) await cancelOnReader(current.paymentIntentId);
      await start(next === "embedded" ? { embedded: true } : next === "reader" ? { readerId } : { embedded: false });
      setMode(next);
      if (next === "reader") setReaderLabel(readers.find(r => r.id === readerId)?.label ?? "the card reader");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  }

  async function cancelOnReader(paymentIntentId: string) {
    await fetch(`/api/events/${eventId}/reader-payments/${paymentIntentId}/cancel`, { method: "POST", credentials: "include" }).catch(() => {});
  }

  async function simulateTap() {
    if (!current?.paymentIntentId) return;
    const res = await fetch(`/api/events/${eventId}/reader-payments/${current.paymentIntentId}/simulate`, { method: "POST", credentials: "include" });
    if (!res.ok) setError(responseErrorMessage(res.status, await res.json().catch(() => null)));
  }

  // First view: a payment the page already started shows as it is; otherwise, with a
  // reader online let staff pick, and without one open the form right away.
  useEffect(() => {
    if (begun.current) return;
    if (current) {
      begun.current = true;
      setMode(current.paymentIntentId ? "reader" : current.clientSecret ? "embedded" : "phone");
      return;
    }
    if (readersLoading) return;
    begun.current = true;
    if (onlineReaders.length === 0) void go("embedded");
  }, [readersLoading, current]); // eslint-disable-line react-hooks/exhaustive-deps

  const money = `$${amount.toFixed(2)}`;
  const options = (
    <div className="flex flex-wrap justify-center gap-2">
      {mode !== "embedded" && (
        <Button variant="outline" size="sm" className="gap-1.5" disabled={starting} onClick={() => go("embedded")}>
          <Keyboard size={14} /> Type card here
        </Button>
      )}
      {readers.map(r => (mode !== "reader" || readerLabel !== r.label) && (
        <Button key={r.id} variant="outline" size="sm" className="gap-1.5" disabled={starting || r.status !== "online"}
          title={r.status !== "online" ? `${r.label} is offline` : undefined} onClick={() => go("reader", r.id)}>
          {r.status === "online" ? <Wifi size={14} /> : <WifiOff size={14} />} {r.label}
        </Button>
      ))}
      {mode !== "phone" && (
        <Button variant="outline" size="sm" className="gap-1.5" disabled={starting} onClick={() => go("phone")}>
          <Smartphone size={14} /> Rider's phone
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3 w-full">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {mode === null && !starting && onlineReaders.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground text-center">How is the rider paying <strong>{money}</strong>?</p>
          <div className="grid gap-2 w-full">
            {onlineReaders.map(r => (
              <Button key={r.id} className="h-12 gap-2" onClick={() => go("reader", r.id)}>
                <CreditCard size={18} /> Charge on {r.label}
              </Button>
            ))}
            <Button variant="outline" className="h-11 gap-2" onClick={() => go("embedded")}><Keyboard size={16} /> Type card here</Button>
            <Button variant="outline" className="h-11 gap-2" onClick={() => go("phone")}><Smartphone size={16} /> Rider pays on their phone</Button>
          </div>
        </>
      )}

      {starting && <div className="flex justify-center py-8"><Loader2 className="animate-spin text-muted-foreground" /></div>}

      {!starting && mode === "embedded" && current?.clientSecret && (
        <EmbeddedCardForm clientSecret={current.clientSecret} />
      )}

      {!starting && mode === "reader" && current?.paymentIntentId && (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <CreditCard size={36} className="text-primary" />
          <p className="font-heading font-bold uppercase tracking-wide">{money} sent to {readerLabel}</p>
          <p className="text-sm text-muted-foreground">Ask the rider to tap, insert or swipe their card on the reader.</p>
          {stripeConfig?.testMode && (
            <Button variant="outline" size="sm" onClick={simulateTap}>Simulate a card tap (test mode)</Button>
          )}
        </div>
      )}

      {!starting && mode === "phone" && current?.checkoutUrl && (
        <>
          <p className="text-sm text-center flex items-center gap-1.5"><Smartphone size={16} /> Rider scans to pay {money} on their phone</p>
          <div className="p-3 bg-white rounded-xl border shadow-sm"><QRCodeSVG value={current.checkoutUrl} size={180} /></div>
        </>
      )}

      {mode !== null && (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Waiting for payment. This closes by itself once paid.
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground w-full">
            <span className="h-px bg-border flex-1" /> or pay another way <span className="h-px bg-border flex-1" />
          </div>
          {options}
        </>
      )}

      <Button variant="ghost" size="sm" className="text-xs" onClick={async () => {
        if (current?.paymentIntentId) await cancelOnReader(current.paymentIntentId);
        onCancel();
      }}>
        Cancel
      </Button>
    </div>
  );
}
