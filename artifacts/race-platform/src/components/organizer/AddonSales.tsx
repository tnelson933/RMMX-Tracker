import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { responseErrorMessage } from "@/lib/friendlyErrors";

interface MethodTotal { count: number; total: number }
interface AddonLine { count: number; cash: MethodTotal; card: MethodTotal; unpaid: number; collected: number }
export interface AddonSalesData {
  rentals: AddonLine;
  rmTrackr: AddonLine;
  rfidTags: AddonLine;
  /** Paid at check-in only (the rest came with the registration's payment). */
  collectedAtCheckin: { cash: MethodTotal; card: MethodTotal };
}

export function useAddonSales(eventId: number) {
  return useQuery<AddonSalesData>({
    queryKey: ["/api/events", eventId, "addon-sales"],
    enabled: !!eventId,
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/addon-sales`, { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
      return body;
    },
  });
}

const money = (n: number) => `$${n.toFixed(2)}`;
const paidCell = (m: MethodTotal) => (m.count ? `${money(m.total)} (${m.count})` : "—");

/**
 * Event report: transponders rented and RM TrackR / RFID tags sold, with what
 * was collected by cash and card (at check-in or with the entry) and how many
 * are still unpaid.
 */
export function AddonSalesSection({ eventId }: { eventId: number }) {
  const { data, isLoading, isError, error } = useAddonSales(eventId);
  if (isLoading) return null;

  const rows: Array<[string, string, AddonLine]> = data ? [
    ["Transponder rentals", "rented", data.rentals],
    ["RM TrackR Transponders", "sold", data.rmTrackr],
    ...(data.rfidTags.count > 0 ? [["RFID tags", "sold", data.rfidTags] as [string, string, AddonLine]] : []),
  ] : [];
  const totalCash = rows.reduce((s, [, , l]) => s + l.cash.total, 0);
  const totalCard = rows.reduce((s, [, , l]) => s + l.card.total, 0);

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-heading font-bold uppercase border-b pb-2 print:border-black">Transponder Rentals &amp; Sales</h3>
      {isError ? (
        <p className="text-sm text-muted-foreground">Couldn't load rentals and sales: {(error as Error)?.message}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="print:border-black print:shadow-none"><CardContent className="p-4">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Rented out</p>
              <p className="text-3xl font-heading font-bold">{data!.rentals.count}</p>
            </CardContent></Card>
            <Card className="print:border-black print:shadow-none"><CardContent className="p-4">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">RM TrackR sold</p>
              <p className="text-3xl font-heading font-bold">{data!.rmTrackr.count}</p>
            </CardContent></Card>
            <Card className="print:border-black print:shadow-none"><CardContent className="p-4">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Cash</p>
              <p className="text-3xl font-heading font-bold text-green-600">{money(totalCash)}</p>
            </CardContent></Card>
            <Card className="print:border-black print:shadow-none"><CardContent className="p-4">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Card</p>
              <p className="text-3xl font-heading font-bold text-blue-600">{money(totalCard)}</p>
            </CardContent></Card>
          </div>
          <div className="rounded-md border print:border-black">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 print:bg-transparent">
                  <TableHead className="font-heading font-bold uppercase tracking-wider text-black">Item</TableHead>
                  <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Rented / Sold</TableHead>
                  <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Cash</TableHead>
                  <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Card</TableHead>
                  <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Collected</TableHead>
                  <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Unpaid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(([label, verb, l]) => (
                  <TableRow key={label}>
                    <TableCell className="font-bold">{label}</TableCell>
                    <TableCell className="text-right">{l.count} {verb}</TableCell>
                    <TableCell className="text-right">{paidCell(l.cash)}</TableCell>
                    <TableCell className="text-right">{paidCell(l.card)}</TableCell>
                    <TableCell className="text-right font-bold">{money(l.collected)}</TableCell>
                    <TableCell className={`text-right ${l.unpaid ? "text-amber-700 font-semibold" : ""}`}>{l.unpaid}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Counts in brackets are payments. Includes rentals and sales paid at check-in and those paid with the rider's entry.
            Unpaid: rented or bought but not paid yet (pay-at-gate entries not marked paid).
          </p>
        </>
      )}
    </div>
  );
}
