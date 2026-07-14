import { useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useListEventCancellations, useVerifyCancellationRefund, getListEventCancellationsQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, Banknote, CreditCard, DollarSign, AlertCircle } from "lucide-react";
import { format } from "date-fns";

function fmtMoney(amount: number | null | undefined) {
  if (amount == null) return "—";
  return `$${amount.toFixed(2)}`;
}

function PaymentMethodIcon({ method }: { method: string | null | undefined }) {
  if (method === "card") return <CreditCard size={14} className="inline mr-1 text-muted-foreground" />;
  if (method === "cash") return <Banknote size={14} className="inline mr-1 text-muted-foreground" />;
  return <DollarSign size={14} className="inline mr-1 text-muted-foreground" />;
}

export default function Cancellations() {
  const [, params] = useRoute("/events/:eventId/cancellations");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useListEventCancellations(eventId, { query: { enabled: !!eventId } as any });

  const verifyMutation = useVerifyCancellationRefund({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEventCancellationsQueryKey(eventId) as any });
      },
    },
  });

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading cancellations…</div>;
  if (error) return (
    <div className="p-8 flex items-center gap-3 text-destructive">
      <AlertCircle size={20} />
      <span>Failed to load cancellations.</span>
    </div>
  );

  const cancellations = data?.cancellations ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-heading font-bold uppercase tracking-tight">Cancellations</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Rider-initiated registration cancellations. Mark refunds verified after you process them outside the platform.
          </p>
        </div>
        {(data?.unverifiedCount ?? 0) > 0 && (
          <Badge variant="destructive" className="text-sm px-3 py-1">
            {data!.unverifiedCount} Pending Refund{data!.unverifiedCount !== 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      {cancellations.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <CheckCircle2 size={40} className="text-muted-foreground" />
          <p className="text-lg font-semibold font-heading uppercase">No Cancellations</p>
          <p className="text-sm text-muted-foreground">No riders have cancelled their registrations for this event.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rider</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Bib #</TableHead>
              <TableHead>Amount Paid</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead>Cancelled At</TableHead>
              <TableHead>Refund Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cancellations.map(c => {
              const verified = c.refundVerifiedAt != null;
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.riderName}</TableCell>
                  <TableCell>{c.raceClass}</TableCell>
                  <TableCell>{c.bibNumber ?? "—"}</TableCell>
                  <TableCell>{fmtMoney(c.amountPaid)}</TableCell>
                  <TableCell>
                    <PaymentMethodIcon method={c.paymentMethod} />
                    <span className="text-sm text-muted-foreground capitalize">{c.paymentMethod ?? "—"}</span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.cancelledAt ? format(new Date(c.cancelledAt), "MMM d, yyyy h:mm a") : "—"}
                  </TableCell>
                  <TableCell>
                    {verified ? (
                      <span className="inline-flex items-center gap-1 text-sm text-green-600 font-medium">
                        <CheckCircle2 size={14} />
                        Refunded
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-sm text-amber-600 font-medium">
                        <Clock size={14} />
                        Pending
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {!verified && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={verifyMutation.isPending}
                        onClick={() => verifyMutation.mutate({ eventId, registrationId: c.id })}
                      >
                        <CheckCircle2 size={14} className="mr-1" />
                        Mark Refunded
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
