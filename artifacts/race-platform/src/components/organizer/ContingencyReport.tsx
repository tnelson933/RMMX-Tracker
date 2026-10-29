import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OfficialResultsBadge } from "@/components/OfficialResultsBadge";
import { contingencyCsv, contingencyFileName, type ContingencyReportData } from "@/lib/contingencyCsv";
import { Download, Flag } from "lucide-react";
import { responseErrorMessage } from "@/lib/friendlyErrors";

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Report tab → Brand Contingency Report: for each brand the event offers
 * contingency with, the finishers who ran it (bike brand or a listed sponsor)
 * with class, place and class size. Promoters send each brand its file, or
 * upload it to XTRM; the brand applies its own rules (places, model years).
 */
export function ContingencyReport({ eventId }: { eventId: number }) {
  const { data, isLoading, isError, refetch } = useQuery<ContingencyReportData>({
    queryKey: ["/api/events", eventId, "contingency-report"],
    enabled: !!eventId,
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/contingency-report`, { credentials: "include" });
      if (!res.ok) throw new Error(responseErrorMessage(res.status));
      return res.json();
    },
  });

  if (isLoading) return null;
  const total = data?.brands.reduce((n, b) => n + b.finishers.length, 0) ?? 0;

  return (
    <Card className="print:hidden">
      <CardContent className="p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Flag size={18} className="text-primary" />
            </div>
            <div>
              <h2 className="font-heading font-bold uppercase tracking-wide text-lg flex flex-wrap items-center gap-2">
                Brand Contingency Report
                {data && data.brands.length > 0 && <OfficialResultsBadge official={data.official} />}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Each brand's finishers, matched by the bike brand or sponsors riders entered at registration, with their class place.
                Send each brand its file (or upload it to XTRM) after results are official; the brand applies its own rules for places, classes and model years.
              </p>
            </div>
          </div>
          {data && total > 0 && (
            <Button variant="outline" className="gap-1.5" onClick={() => download(contingencyFileName(data.eventName), contingencyCsv(data))}>
              <Download size={14} /> All brands (CSV)
            </Button>
          )}
        </div>

        {isError || !data ? (
          <p className="text-sm text-muted-foreground">
            Couldn't load the contingency report. <button className="underline" onClick={() => refetch()}>Try again</button>
          </p>
        ) : data.brands.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This event has no contingency brands. Add your brands in{" "}
            <Link href="/team?tab=brands" className="underline">Admin → Brand Contingencies</Link>, then check them when you edit the event.
          </p>
        ) : (
          <div className="space-y-5">
            {!data.official && (
              <p className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Results aren't official yet. Finalize the races on Race Day Management before sending this to brands.
              </p>
            )}
            {data.brands.map(b => (
              <div key={b.brand} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-heading font-bold uppercase tracking-wide">
                    {b.brand} <span className="text-muted-foreground font-normal normal-case text-sm">· {b.finishers.length} finisher{b.finishers.length === 1 ? "" : "s"}</span>
                  </h3>
                  {b.finishers.length > 0 && (
                    <Button size="sm" variant="ghost" className="gap-1.5 h-8" onClick={() => download(contingencyFileName(data.eventName, b.brand), contingencyCsv(data, b.brand))}>
                      <Download size={13} /> CSV
                    </Button>
                  )}
                </div>
                {b.finishers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No finishers listed {b.brand} as their bike brand or a sponsor.</p>
                ) : (
                  <div className="rounded-md border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Class</TableHead>
                          <TableHead>Place</TableHead>
                          <TableHead>Rider</TableHead>
                          <TableHead>AMA #</TableHead>
                          <TableHead>Bike</TableHead>
                          <TableHead>Runs {b.brand} as</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {b.finishers.map(f => (
                          <TableRow key={`${f.raceClass}-${f.riderId}`}>
                            <TableCell className="whitespace-nowrap">{f.raceClass}</TableCell>
                            <TableCell className="whitespace-nowrap font-bold">{f.position} <span className="font-normal text-muted-foreground">of {f.classSize}</span></TableCell>
                            <TableCell className="whitespace-nowrap">
                              {f.bibNumber && <span className="font-mono text-muted-foreground mr-1.5">#{f.bibNumber}</span>}
                              {[f.firstName, f.lastName].filter(Boolean).join(" ")}
                            </TableCell>
                            <TableCell className="font-mono">{f.amaNumber ?? <span className="text-muted-foreground">—</span>}</TableCell>
                            <TableCell className="whitespace-nowrap">{[f.bikeYear, f.bikeBrand, f.bikeModel].filter(Boolean).join(" ") || "—"}</TableCell>
                            <TableCell>{f.matchedBy === "bike" ? "Bike" : "Sponsor"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
