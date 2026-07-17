import { useState } from "react";
import { StateSelect } from "@/components/ui/StateSelect";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useListRiders, useCreateRider, getListRidersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Users, Search, Plus, ChevronRight, Tag, Download, FileSpreadsheet, FileText, File, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";

const createRiderSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  bibNumber: z.string().optional(),
  rfidNumber: z.string().optional(),
  amaNumber: z.string().optional(),
  mylapsTransponderId: z.string().optional(),
  bikeManufacturer: z.string().optional(),
  sponsors: z.string().optional(),
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  homeState: z.string().optional(),
  zip: z.string().optional(),
});

type ExportRider = {
  id: number;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  bibNumber?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  homeState?: string | null;
  zip?: string | null;
  bikeManufacturer?: string | null;
  amaNumber?: string | null;
  rfidNumber?: string | null;
  mylapsTransponderId?: string | null;
  sponsors?: string | null;
  dateOfBirth?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
};

type SortKey = "name" | "bib" | "cityState" | "bike" | "ama" | "rfid" | "mylaps";
type SortDir = "asc" | "desc";

function toExportRows(riders: ExportRider[]) {
  return riders.map((r) => ({
    ID: r.id,
    "First Name": r.firstName,
    "Last Name": r.lastName,
    "#": r.bibNumber ?? "",
    "Street Address": r.streetAddress ?? "",
    City: r.city ?? "",
    State: r.homeState ?? "",
    ZIP: r.zip ?? "",
    "Bike Manufacturer": r.bikeManufacturer ?? "",
    "AMA #": r.amaNumber ?? "",
    "RFID #": r.rfidNumber ?? "",
    "MyLaps Transponder #": r.mylapsTransponderId ?? "",
    Sponsors: r.sponsors ?? "",
    Email: r.email ?? "",
    Phone: r.phone ?? "",
    "Date of Birth": r.dateOfBirth ?? "",
    "Emergency Contact": r.emergencyContact ?? "",
    "Emergency Phone": r.emergencyPhone ?? "",
  }));
}

function exportCSV(riders: ExportRider[]) {
  const rows = toExportRows(riders);
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [headers.map(escape).join(","), ...rows.map((r) => headers.map((h) => escape((r as any)[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "rider-database.csv";
  a.click();
  URL.revokeObjectURL(url);
}

async function exportExcel(riders: ExportRider[]) {
  const XLSX = await import("xlsx");
  const rows = toExportRows(riders);
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Riders");
  XLSX.writeFile(wb, "rider-database.xlsx");
}

async function exportPDF(riders: ExportRider[]) {
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(14);
  doc.text("Rider Database", 14, 16);
  doc.setFontSize(9);
  doc.text(`Exported ${new Date().toLocaleDateString()}`, 14, 22);

  const rows = toExportRows(riders);
  const headers = Object.keys(rows[0]);
  autoTable(doc, {
    head: [headers],
    body: rows.map((r) => headers.map((h) => (r as any)[h])),
    startY: 27,
    styles: { fontSize: 7 },
    headStyles: { fillColor: [20, 20, 20] },
  });
  doc.save("rider-database.pdf");
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <ArrowUpDown size={13} className="ml-1 opacity-30 shrink-0" />;
  return sortDir === "asc"
    ? <ArrowUp size={13} className="ml-1 text-primary shrink-0" />
    : <ArrowDown size={13} className="ml-1 text-primary shrink-0" />;
}

function sortRiders<T extends ExportRider>(riders: T[], key: SortKey, dir: SortDir): T[] {
  const d = dir === "asc" ? 1 : -1;
  return [...riders].sort((a, b) => {
    const nullLast = (va: string, vb: string) => {
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return va.localeCompare(vb) * d;
    };

    switch (key) {
      case "name":
        return `${a.firstName} ${a.lastName}`.toLowerCase()
          .localeCompare(`${b.firstName} ${b.lastName}`.toLowerCase()) * d;
      case "bib": {
        const na = a.bibNumber ? Number(a.bibNumber) : NaN;
        const nb = b.bibNumber ? Number(b.bibNumber) : NaN;
        if (!a.bibNumber && !b.bibNumber) return 0;
        if (!a.bibNumber) return 1;
        if (!b.bibNumber) return -1;
        if (!isNaN(na) && !isNaN(nb)) return (na - nb) * d;
        return (a.bibNumber ?? "").localeCompare(b.bibNumber ?? "") * d;
      }
      case "cityState":
        return nullLast(
          [(a as any).city, (a as any).homeState].filter(Boolean).join(", ").toLowerCase(),
          [(b as any).city, (b as any).homeState].filter(Boolean).join(", ").toLowerCase(),
        );
      case "bike":
        return nullLast(
          ((a as any).bikeManufacturer ?? "").toLowerCase(),
          ((b as any).bikeManufacturer ?? "").toLowerCase(),
        );
      case "ama":
        return nullLast(
          ((a as any).amaNumber ?? "").toLowerCase(),
          ((b as any).amaNumber ?? "").toLowerCase(),
        );
      case "rfid": {
        const hasA = a.rfidNumber ? 1 : 0;
        const hasB = b.rfidNumber ? 1 : 0;
        return (hasA - hasB) * d;
      }
      case "mylaps":
        return nullLast(
          ((a as any).mylapsTransponderId ?? "").toLowerCase(),
          ((b as any).mylapsTransponderId ?? "").toLowerCase(),
        );
      default:
        return 0;
    }
  });
}

export default function RidersList() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const clubId = user?.clubId ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const trimmedSearch = search.trim();

  const { data: riders, isLoading } = useListRiders(
    isSuperAdmin
      ? { search: trimmedSearch.length > 2 ? trimmedSearch : undefined }
      : { clubId: clubId ?? 0, search: trimmedSearch.length > 2 ? trimmedSearch : undefined },
    { query: { enabled: isSuperAdmin || !!clubId } as any }
  );

  const createMutation = useCreateRider();

  const form = useForm<z.infer<typeof createRiderSchema>>({
    resolver: zodResolver(createRiderSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      bibNumber: "",
      rfidNumber: "",
      amaNumber: "",
      mylapsTransponderId: "",
      bikeManufacturer: "",
      sponsors: "",
      streetAddress: "",
      city: "",
      homeState: "",
      zip: "",
    },
  });

  const onSubmit = (data: z.infer<typeof createRiderSchema>) => {
    createMutation.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: isSuperAdmin ? getListRidersQueryKey({}) : getListRidersQueryKey({ clubId: clubId ?? 0 }),
          });
          setIsAddOpen(false);
          form.reset();
          toast({ title: "Rider added successfully" });
        },
        onError: (err) => {
          toast({ title: "Failed to add rider", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const filteredRiders = (riders ?? []).filter((r) => {
    if (trimmedSearch.length <= 2) {
      const s = trimmedSearch.toLowerCase();
      if (!s) return true;
      const fullName = `${r.firstName} ${r.lastName}`.toLowerCase();
      return (
        fullName.includes(s) ||
        r.firstName.toLowerCase().includes(s) ||
        r.lastName.toLowerCase().includes(s) ||
        (r.bibNumber && r.bibNumber.toLowerCase().includes(s)) ||
        (r.email && r.email.toLowerCase().includes(s)) ||
        (r.phone && r.phone.toLowerCase().includes(s))
      );
    }
    return true;
  });

  const displayRiders = sortRiders(filteredRiders as ExportRider[], sortKey, sortDir);

  const handleExportCSV = () => {
    if (!displayRiders.length) { toast({ title: "No riders to export" }); return; }
    exportCSV(displayRiders);
  };

  const handleExportExcel = () => {
    if (!displayRiders.length) { toast({ title: "No riders to export" }); return; }
    exportExcel(displayRiders).catch(() =>
      toast({ title: "Excel export failed", variant: "destructive" })
    );
  };

  const handleExportPDF = () => {
    if (!displayRiders.length) { toast({ title: "No riders to export" }); return; }
    exportPDF(displayRiders).catch(() =>
      toast({ title: "PDF export failed", variant: "destructive" })
    );
  };

  const thClass = "text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider select-none";
  const thSortable = `${thClass} cursor-pointer hover:text-sidebar-foreground transition-colors`;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Users className="text-primary" /> Rider Database
          </h1>
          <p className="text-muted-foreground mt-1">Manage rider profiles and assignments.</p>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="font-heading uppercase tracking-wider gap-2">
                <Download size={16} /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={handleExportCSV} className="gap-2 cursor-pointer">
                <File size={15} /> Export CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportExcel} className="gap-2 cursor-pointer">
                <FileSpreadsheet size={15} /> Export Excel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportPDF} className="gap-2 cursor-pointer">
                <FileText size={15} /> Export PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="font-heading uppercase tracking-wider">
                <Plus size={16} className="mr-2" /> Add Rider
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle className="font-heading uppercase text-xl">Add New Rider</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 pt-2">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="firstName" render={({ field }) => (
                      <FormItem><FormLabel>First Name *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="lastName" render={({ field }) => (
                      <FormItem><FormLabel>Last Name *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="email" render={({ field }) => (
                      <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="phone" render={({ field }) => (
                      <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>

                  <FormField control={form.control} name="streetAddress" render={({ field }) => (
                    <FormItem><FormLabel>Street Address</FormLabel><FormControl><Input placeholder="123 Dirt Track Rd" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <div className="grid grid-cols-3 gap-4">
                    <FormField control={form.control} name="city" render={({ field }) => (
                      <FormItem><FormLabel>City</FormLabel><FormControl><Input placeholder="Tucson" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="homeState" render={({ field }) => (
                      <FormItem><FormLabel>State</FormLabel><FormControl><StateSelect value={field.value} onChange={field.onChange} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="zip" render={({ field }) => (
                      <FormItem><FormLabel>ZIP</FormLabel><FormControl><Input placeholder="85701" maxLength={10} {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  <FormField control={form.control} name="bikeManufacturer" render={({ field }) => (
                    <FormItem><FormLabel>Bike Manufacturer</FormLabel><FormControl><Input placeholder="Honda, KTM, Yamaha…" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />

                  <div className="grid grid-cols-3 gap-4">
                    <FormField control={form.control} name="bibNumber" render={({ field }) => (
                      <FormItem><FormLabel>#</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="amaNumber" render={({ field }) => (
                      <FormItem><FormLabel>AMA #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="rfidNumber" render={({ field }) => (
                      <FormItem><FormLabel>RFID Tag #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>

                  <FormField control={form.control} name="mylapsTransponderId" render={({ field }) => (
                    <FormItem><FormLabel>MyLaps Transponder #</FormLabel><FormControl><Input placeholder="Transponder ID" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />

                  <FormField control={form.control} name="sponsors" render={({ field }) => (
                    <FormItem><FormLabel>Sponsors</FormLabel><FormControl><Input placeholder="e.g. Fox Racing, Alpinestars, FMF" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />

                  <div className="pt-2 flex justify-end">
                    <Button type="submit" disabled={createMutation.isPending} className="font-heading uppercase tracking-wider">
                      {createMutation.isPending ? "Adding..." : "Add Rider"}
                    </Button>
                  </div>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <div className="p-4 border-b bg-muted/30">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, bib, phone, or email..."
              className="pl-10"
            />
          </div>
        </div>
        <div className="rounded-b-md overflow-x-auto">
          <Table>
            <TableHeader className="bg-sidebar text-sidebar-foreground">
              <TableRow className="hover:bg-sidebar">
                <TableHead
                  className={thSortable}
                  onClick={() => handleSort("name")}
                >
                  <span className="inline-flex items-center">
                    Name <SortIcon col="name" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </TableHead>
                <TableHead
                  className={`w-20 text-center ${thSortable}`}
                  onClick={() => handleSort("bib")}
                >
                  <span className="inline-flex items-center justify-center w-full">
                    # <SortIcon col="bib" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </TableHead>
                <TableHead
                  className={thSortable}
                  onClick={() => handleSort("cityState")}
                >
                  <span className="inline-flex items-center">
                    City / State <SortIcon col="cityState" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </TableHead>
                <TableHead
                  className={thSortable}
                  onClick={() => handleSort("bike")}
                >
                  <span className="inline-flex items-center">
                    Bike <SortIcon col="bike" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </TableHead>
                <TableHead
                  className={`w-28 text-center ${thSortable}`}
                  onClick={() => handleSort("ama")}
                >
                  <span className="inline-flex items-center justify-center w-full">
                    AMA # <SortIcon col="ama" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </TableHead>
                <TableHead
                  className={`w-28 text-center ${thSortable}`}
                  onClick={() => handleSort("rfid")}
                >
                  <span className="inline-flex items-center justify-center w-full">
                    RFID <SortIcon col="rfid" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </TableHead>
                <TableHead
                  className={`w-36 text-center ${thSortable}`}
                  onClick={() => handleSort("mylaps")}
                >
                  <span className="inline-flex items-center justify-center w-full">
                    MyLaps <SortIcon col="mylaps" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </TableHead>
                <TableHead className="w-8"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12">Loading riders...</TableCell>
                </TableRow>
              ) : displayRiders.length > 0 ? (
                displayRiders.map((rider) => (
                  <TableRow
                    key={rider.id}
                    className="hover:bg-muted/50 cursor-pointer group"
                    onClick={() => (window.location.href = `/riders/${rider.id}`)}
                  >
                    <TableCell className="font-bold">{rider.firstName} {rider.lastName}</TableCell>
                    <TableCell className="text-center">
                      {rider.bibNumber ? (
                        <span className="font-mono bg-muted px-2 py-0.5 rounded border text-sm">{rider.bibNumber}</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {((rider as any).city || (rider as any).homeState)
                        ? [(rider as any).city, (rider as any).homeState].filter(Boolean).join(", ")
                        : <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {(rider as any).bikeManufacturer || <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell className="text-center font-mono text-sm">
                      {(rider as any).amaNumber || <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell className="text-center">
                      {rider.rfidNumber ? (
                        <span className="inline-flex items-center gap-1 text-xs text-primary font-bold bg-primary/10 px-2 py-0.5 rounded">
                          <Tag size={11} /> Active
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40 text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center font-mono text-sm">
                      {(rider as any).mylapsTransponderId || <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="text-muted-foreground group-hover:text-primary transition-colors" size={16} />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                    <Users size={48} className="mx-auto opacity-20 mb-4" />
                    <p className="text-lg font-medium">No riders found</p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
