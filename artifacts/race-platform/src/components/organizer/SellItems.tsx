import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Eye, EyeOff, Loader2, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { RM_TRACKR_NAME, RM_TRACKR_OPTION_ID, RM_TRACKR_PRICE } from "@/lib/rmTrackr";

export interface SellItem {
  id: number;
  kind: "rm_trackr" | "rfid_tag" | "custom";
  name: string;
  price: number | null;
  hidden: boolean;
}

export const SELL_ITEMS_KEY = ["/api/sell-items"];

/** The club's sell items (Admin → Sell Items). */
export function useSellItems(enabled = true) {
  return useQuery<SellItem[]>({
    queryKey: SELL_ITEMS_KEY,
    enabled,
    queryFn: async () => {
      const res = await fetch("/api/sell-items", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
}

async function send(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method, credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "That didn't save. Please try again.");
  return json;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Admin → Sell Items. The RM TrackR Transponder and RFID Tag are always here:
 * set their prices (check-in sells them at these prices, and new events offer
 * them). Add anything else the club sells (camping, pit passes…); event forms
 * show every item as a one-click purchase option.
 */
export function SellItemsManager() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: items = [], isLoading, isError, refetch } = useSellItems();
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [busy, setBusy] = useState<number | "new" | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: SELL_ITEMS_KEY });

  async function run(target: number | "new", action: () => Promise<unknown>, failTitle: string) {
    setBusy(target);
    try {
      await action();
      await refresh();
      return true;
    } catch (err) {
      toast({ title: failTitle, description: err instanceof Error ? err.message : String(err), variant: "destructive" });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const ok = await run("new", () => send("POST", "/api/sell-items", { name: newName, price: newPrice }), "Couldn't add the item");
    if (ok) { setNewName(""); setNewPrice(""); }
  }

  return (
    <div className="rounded-xl border bg-card p-6 mb-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <ShoppingBag size={18} className="text-primary" />
        </div>
        <div>
          <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Sell Items</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            What your club sells to riders. Check-in sells the RM TrackR Transponder and RFID Tag at these prices, and every item is a one-click purchase option when you create an event.
            Changing a price doesn't change events that already offer the item.
          </p>
        </div>
      </div>

      {isError ? (
        <p className="text-sm text-muted-foreground">Couldn't load your items. <button className="underline" onClick={() => refetch()}>Try again</button></p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 ${item.hidden ? "bg-muted/20 opacity-70" : "bg-muted/30"}`}>
              {item.kind === "custom" ? (
                <Input
                  defaultValue={item.name}
                  className="h-8 w-56 text-sm font-semibold"
                  aria-label={`Name of ${item.name}`}
                  onBlur={e => {
                    const v = e.target.value.trim();
                    if (v && v !== item.name) void run(item.id, () => send("PATCH", `/api/sell-items/${item.id}`, { name: v }), "Couldn't rename the item");
                  }}
                />
              ) : (
                <span className="text-sm font-semibold w-56">{item.name}</span>
              )}
              <div className="relative">
                <span className="absolute left-2.5 top-1.5 text-sm text-muted-foreground">$</span>
                <Input
                  key={item.price ?? "none"}
                  type="number" min="0" step="0.01"
                  defaultValue={item.price == null ? "" : item.price.toFixed(2)}
                  placeholder={item.kind === "rfid_tag" ? "Set a price" : "0.00"}
                  className="h-8 w-28 pl-6 text-sm"
                  aria-label={`Price of ${item.name}`}
                  onBlur={e => {
                    const v = e.target.value.trim();
                    const current = item.price == null ? "" : item.price.toFixed(2);
                    if (v !== current && !(v !== "" && Number(v) === item.price)) {
                      void run(item.id, () => send("PATCH", `/api/sell-items/${item.id}`, { price: v }), "Couldn't change the price");
                    }
                  }}
                />
              </div>
              {item.kind !== "custom" && <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Built in</span>}
              {item.kind === "rfid_tag" && item.price == null && (
                <span className="text-xs text-amber-700">Set a price to sell RFID tags at check-in.</span>
              )}
              <span className="flex-1" />
              {busy === item.id ? <Loader2 size={14} className="animate-spin text-muted-foreground" /> : (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                    onClick={() => run(item.id, () => send("PATCH", `/api/sell-items/${item.id}`, { hidden: !item.hidden }), "Couldn't update the item")}
                    title={item.hidden ? "Show it on event forms again" : "Hide it from event forms and check-in"}>
                    {item.hidden ? <><Eye size={12} /> Show</> : <><EyeOff size={12} /> Hide</>}
                  </Button>
                  {item.kind === "custom" && (
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${item.name}`} title="Remove item (events that offer it keep it)"
                      onClick={() => {
                        if (window.confirm(`Remove ${item.name}? Events that already offer it keep it.`)) {
                          void run(item.id, () => send("DELETE", `/api/sell-items/${item.id}`), "Couldn't remove the item");
                        }
                      }}>
                      <Trash2 size={13} />
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border bg-muted/20 p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add an item</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Camping, pit pass, wristband…" className="h-9 w-64" aria-label="New item name" />
          <div className="relative">
            <span className="absolute left-2.5 top-2 text-sm text-muted-foreground">$</span>
            <Input value={newPrice} onChange={e => setNewPrice(e.target.value)} type="number" min="0" step="0.01" placeholder="0.00" className="h-9 w-28 pl-6" aria-label="New item price" />
          </div>
          <Button onClick={add} disabled={busy === "new" || !newName.trim() || newPrice === ""} className="gap-1.5">
            {busy === "new" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add item
          </Button>
        </div>
      </div>
    </div>
  );
}

type FormPurchaseOption = { optionId?: string; name?: string; amount?: string };

/** The RM TrackR as an event purchase option, at the club's Sell Items price. */
export function useTrackrPurchaseOption(): Required<Pick<FormPurchaseOption, "optionId" | "name" | "amount">> {
  const { data: items } = useSellItems();
  const price = items?.find(i => i.kind === "rm_trackr")?.price ?? RM_TRACKR_PRICE;
  return { optionId: RM_TRACKR_OPTION_ID, name: RM_TRACKR_NAME, amount: String(price) };
}

/**
 * One-click purchase options from the club's Sell Items, for the event forms.
 * Items the event already offers are skipped. The RFID Tag isn't listed: it's
 * sold through the event's RFID sticker setting and at check-in.
 */
export function SellItemQuickAdd({ options, onAdd }: { options: FormPurchaseOption[]; onAdd: (option: FormPurchaseOption) => void }) {
  const { data: items, isError } = useSellItems();
  const offered = (item: Pick<SellItem, "kind" | "name">) => item.kind === "rm_trackr"
    ? options.some(o => o.optionId === RM_TRACKR_OPTION_ID)
    : options.some(o => o.optionId !== RM_TRACKR_OPTION_ID && o.name?.trim().toLowerCase() === item.name.toLowerCase());
  // Without the club's list (offline, or it didn't load), still offer the RM TrackR.
  const list: Array<Pick<SellItem, "kind" | "name" | "price">> = items
    ? items.filter(i => !i.hidden && i.price != null && i.kind !== "rfid_tag")
    : isError ? [{ kind: "rm_trackr", name: RM_TRACKR_NAME, price: RM_TRACKR_PRICE }] : [];
  const available = list.filter(i => !offered(i));
  if (list.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Quick add:</span>
      {available.map(item => (
        <button
          key={`${item.kind}-${item.name}`}
          type="button"
          onClick={() => onAdd(item.kind === "rm_trackr"
            ? { optionId: RM_TRACKR_OPTION_ID, name: RM_TRACKR_NAME, amount: String(item.price) }
            : { name: item.name, amount: String(item.price) })}
          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 font-semibold text-primary hover:bg-primary/10 transition-colors"
        >
          <Plus size={11} /> {item.name} {money(item.price ?? 0)}
        </button>
      ))}
      {available.length === 0 && <span className="text-muted-foreground">all your items are added.</span>}
      {items && (
        <Link href="/team?tab=sell" className="ml-1 text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Edit items
        </Link>
      )}
    </div>
  );
}

export { money as formatSellItemPrice };
