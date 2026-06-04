import { useRoute } from "wouter";
import { useGetEventReport, useGetRaceDaySummary } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Printer, FileText, Users, Flag, Banknote, CreditCard, DollarSign, Download } from "lucide-react";
import { format } from "date-fns";

export default function Report() {
  const [, params] = useRoute("/events/:eventId/report");
  const eventId = parseInt(params?.eventId || "0");

  const { data: summary, isLoading: summaryLoading } = useGetRaceDaySummary(eventId, { query: { enabled: !!eventId } as any });
  const { data: report, isLoading: reportLoading } = useGetEventReport(eventId, { query: { enabled: !!eventId } as any });

  if (summaryLoading || reportLoading) return <div className="p-8">Loading report data...</div>;

  const ps = (summary as any)?.paymentSummary as {
    cardTotal: number; cashTotal: number; totalCollected: number;
    cardCount: number; cashCount: number;
  } | undefined;

  const hasPayments = ps && (ps.cardCount > 0 || ps.cashCount > 0);

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      {/* Controls */}
      <div className="flex justify-between items-center print:hidden">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
            <FileText className="text-primary" /> Event Report
          </h2>
          <p className="text-muted-foreground mt-1">Summary statistics and post-race reporting.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => {
            const a = document.createElement("a");
            a.href = `/api/events/${eventId}/ama-export`;
            a.download = `ama-export-event-${eventId}.csv`;
            a.click();
          }} className="font-heading uppercase tracking-wider">
            <Download size={16} className="mr-2" /> Export AMA Report
          </Button>
          <Button variant="outline" onClick={() => window.print()} className="font-heading uppercase tracking-wider">
            <Printer size={16} className="mr-2" /> Print Report
          </Button>
        </div>
      </div>

      {/* Print header */}
      <div className="hidden print:block mb-8 text-center border-b-2 border-black pb-4">
        <h1 className="text-4xl font-heading font-bold uppercase">{summary?.eventName}</h1>
        <p className="text-xl mt-2 font-medium">Official Post-Race Report</p>
        <p className="text-sm mt-1">Generated: {format(new Date(), 'PPpp')}</p>
      </div>

      {/* ── Attendance stat cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="print:border-black print:shadow-none">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Unique Registrants</p>
              <h2 className="text-4xl font-heading font-bold">{(summary as any)?.uniqueRegistrants ?? summary?.totalRegistered ?? 0}</h2>
            </div>
            <Users className="text-muted-foreground/30 print:hidden" size={32} />
          </CardContent>
        </Card>

        <Card className="print:border-black print:shadow-none">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Unique Checked In</p>
              <h2 className="text-4xl font-heading font-bold text-secondary">{(summary as any)?.uniqueCheckedIn ?? summary?.checkedIn ?? 0}</h2>
            </div>
            <div className="text-sm font-bold text-secondary bg-secondary/10 px-2 py-1 rounded print:hidden">
              {(summary as any)?.uniqueRegistrants
                ? Math.round(((summary as any).uniqueCheckedIn / (summary as any).uniqueRegistrants) * 100)
                : 0}%
            </div>
          </CardContent>
        </Card>

        <Card className="print:border-black print:shadow-none">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Motos Run</p>
              <h2 className="text-4xl font-heading font-bold">{summary?.motosCompleted || 0} / {summary?.motosScheduled || 0}</h2>
            </div>
            <Flag className="text-muted-foreground/30 print:hidden" size={32} />
          </CardContent>
        </Card>

        <Card className="print:border-black print:shadow-none">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Total Entries</p>
              <h2 className="text-4xl font-heading font-bold">{summary?.totalRegistered || 0}</h2>
            </div>
            <Users className="text-muted-foreground/30 print:hidden" size={32} />
          </CardContent>
        </Card>

        <Card className="print:border-black print:shadow-none">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">No Shows</p>
              <h2 className="text-4xl font-heading font-bold text-destructive">
                {Math.max(0, ((summary as any)?.uniqueRegistrants ?? summary?.totalRegistered ?? 0) - ((summary as any)?.uniqueCheckedIn ?? summary?.checkedIn ?? 0))}
              </h2>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Payment Summary ───────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <h3 className="text-xl font-heading font-bold uppercase border-b pb-2 print:border-black">
          Payment Summary
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Total collected */}
          <Card className="print:border-black print:shadow-none">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-3">
                <DollarSign size={18} className="text-primary" />
                <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Total Collected</p>
              </div>
              <h2 className="text-4xl font-heading font-bold text-primary">
                ${ps ? ps.totalCollected.toFixed(2) : "0.00"}
              </h2>
              <p className="text-xs text-muted-foreground mt-2">
                {ps ? ps.cardCount + ps.cashCount : 0} paid registration{(ps?.cardCount ?? 0) + (ps?.cashCount ?? 0) !== 1 ? "s" : ""}
              </p>
            </CardContent>
          </Card>

          {/* Card / Stripe */}
          <Card className="print:border-black print:shadow-none">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard size={18} className="text-blue-600" />
                <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Card (Stripe)</p>
              </div>
              <h2 className="text-4xl font-heading font-bold text-blue-600">
                ${ps ? ps.cardTotal.toFixed(2) : "0.00"}
              </h2>
              <p className="text-xs text-muted-foreground mt-2">
                {ps?.cardCount ?? 0} rider{(ps?.cardCount ?? 0) !== 1 ? "s" : ""}
                {!hasPayments && <span className="italic"> — no payments recorded</span>}
              </p>
            </CardContent>
          </Card>

          {/* Cash */}
          <Card className="print:border-black print:shadow-none">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-3">
                <Banknote size={18} className="text-green-600" />
                <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Cash</p>
              </div>
              <h2 className="text-4xl font-heading font-bold text-green-600">
                ${ps ? ps.cashTotal.toFixed(2) : "0.00"}
              </h2>
              <p className="text-xs text-muted-foreground mt-2">
                {ps?.cashCount ?? 0} rider{(ps?.cashCount ?? 0) !== 1 ? "s" : ""}
                {!hasPayments && <span className="italic"> — no payments recorded</span>}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Class Breakdown ───────────────────────────────────────────────────── */}
      <div className="space-y-6">
        <h3 className="text-xl font-heading font-bold uppercase border-b pb-2 print:border-black">Class Breakdown</h3>
        <Card className="print:shadow-none print:border-black overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/50 print:bg-transparent">
              <TableRow className="print:border-black">
                <TableHead className="font-heading font-bold uppercase tracking-wider text-black">Class Name</TableHead>
                <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Registered</TableHead>
                <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Checked In</TableHead>
                <TableHead className="text-right font-heading font-bold uppercase tracking-wider text-black">Attendance %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary?.classSummary?.map(cls => (
                <TableRow key={cls.className} className="print:border-black">
                  <TableCell className="font-bold">{cls.className}</TableCell>
                  <TableCell className="text-right">{cls.registered}</TableCell>
                  <TableCell className="text-right font-medium text-secondary">{cls.checkedIn}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {cls.registered ? Math.round((cls.checkedIn / cls.registered) * 100) : 0}%
                  </TableCell>
                </TableRow>
              ))}
              {(!summary?.classSummary || summary.classSummary.length === 0) && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-6 text-muted-foreground">No class data available</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
