import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useGetRider, useUpdateRider, useAssignRfid, getGetRiderQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { User, Tag, History, ChevronLeft, Save, Activity, Bike, Star, MapPin } from "lucide-react";

const updateRiderSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  bibNumber: z.string().optional(),
  dateOfBirth: z.string().optional(),
  emergencyContact: z.string().optional(),
  emergencyPhone: z.string().optional(),
  hometown: z.string().optional(),
  bikeManufacturer: z.string().optional(),
  sponsors: z.string().optional(),
  amaNumber: z.string().optional(),
  mylapsTransponderId: z.string().optional(),
});

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
      <div className="font-medium">{value || <span className="text-muted-foreground/50">—</span>}</div>
    </div>
  );
}

export default function RiderDetail() {
  const [match, params] = useRoute("/riders/:riderId");
  const riderId = parseInt(params?.riderId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: rider, isLoading } = useGetRider(riderId, { query: { enabled: !!riderId } as any });

  const updateMutation = useUpdateRider();
  const assignRfidMutation = useAssignRfid();

  const [isEditing, setIsEditing] = useState(false);
  const [rfidInput, setRfidInput] = useState("");

  const r = rider as any;

  const form = useForm<z.infer<typeof updateRiderSchema>>({
    resolver: zodResolver(updateRiderSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      bibNumber: "",
      dateOfBirth: "",
      emergencyContact: "",
      emergencyPhone: "",
      hometown: "",
      bikeManufacturer: "",
      sponsors: "",
      amaNumber: "",
      mylapsTransponderId: "",
    },
  });

  if (rider && !isEditing && form.getValues("firstName") === "") {
    form.reset({
      firstName: rider.firstName,
      lastName: rider.lastName,
      email: rider.email || "",
      phone: rider.phone || "",
      bibNumber: rider.bibNumber || "",
      dateOfBirth: rider.dateOfBirth || "",
      emergencyContact: rider.emergencyContact || "",
      emergencyPhone: rider.emergencyPhone || "",
      hometown: r.hometown || "",
      bikeManufacturer: r.bikeManufacturer || "",
      sponsors: r.sponsors || "",
      amaNumber: r.amaNumber || "",
      mylapsTransponderId: r.mylapsTransponderId || "",
    });
  }

  const onSubmit = (data: z.infer<typeof updateRiderSchema>) => {
    updateMutation.mutate(
      { riderId, data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetRiderQueryKey(riderId) });
          setIsEditing(false);
          toast({ title: "Rider profile updated" });
        },
        onError: (err) => {
          toast({ title: "Update failed", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleAssignRfid = () => {
    if (!rfidInput) return;
    assignRfidMutation.mutate(
      { data: { riderId, rfidNumber: rfidInput } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetRiderQueryKey(riderId) });
          setRfidInput("");
          toast({ title: "RFID assigned successfully" });
        },
        onError: (err) => {
          toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  if (isLoading) return <div className="p-8">Loading rider...</div>;
  if (!rider) return <div className="p-8">Rider not found</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <Link href="/riders" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground font-medium uppercase tracking-wider mb-2">
        <ChevronLeft size={16} className="mr-1" /> Back to Database
      </Link>

      <div className="flex items-center gap-4 mb-8">
        <div className="w-16 h-16 bg-sidebar rounded-lg flex items-center justify-center text-sidebar-foreground">
          <User size={32} />
        </div>
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">
            {rider.firstName} {rider.lastName}
          </h1>
          <div className="flex items-center gap-3 text-muted-foreground mt-1 flex-wrap">
            {rider.bibNumber && (
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-sm font-bold border">Bib: {rider.bibNumber}</span>
            )}
            {r.hometown && (
              <span className="flex items-center gap-1 text-sm"><MapPin size={13} /> {r.hometown}</span>
            )}
            {r.bikeManufacturer && (
              <span className="flex items-center gap-1 text-sm"><Bike size={13} /> {r.bikeManufacturer}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">

          {/* Personal Information */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
              <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
                <User className="text-primary" size={20} /> Personal Information
              </CardTitle>
              {!isEditing && (
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>Edit Profile</Button>
              )}
            </CardHeader>
            <CardContent className="p-6">
              {isEditing ? (
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                    {/* Name */}
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="firstName" render={({ field }) => (
                        <FormItem><FormLabel>First Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="lastName" render={({ field }) => (
                        <FormItem><FormLabel>Last Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>

                    {/* Contact */}
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="email" render={({ field }) => (
                        <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="phone" render={({ field }) => (
                        <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>

                    {/* Basics */}
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="hometown" render={({ field }) => (
                        <FormItem><FormLabel>Hometown</FormLabel><FormControl><Input placeholder="City, State" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="dateOfBirth" render={({ field }) => (
                        <FormItem><FormLabel>Date of Birth</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>

                    {/* Racing info */}
                    <div className="border-t pt-4 mt-2">
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Racing Info</p>
                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={form.control} name="bikeManufacturer" render={({ field }) => (
                          <FormItem><FormLabel>Bike Manufacturer</FormLabel><FormControl><Input placeholder="Honda, KTM, Yamaha…" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="bibNumber" render={({ field }) => (
                          <FormItem><FormLabel>Default Bib #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                      <div className="grid grid-cols-2 gap-4 mt-4">
                        <FormField control={form.control} name="amaNumber" render={({ field }) => (
                          <FormItem><FormLabel>AMA #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="mylapsTransponderId" render={({ field }) => (
                          <FormItem><FormLabel>MyLaps Transponder #</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                      <div className="mt-4">
                        <FormField control={form.control} name="sponsors" render={({ field }) => (
                          <FormItem><FormLabel>Sponsors</FormLabel><FormControl><Input placeholder="Fox Racing, Alpinestars, FMF…" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                    </div>

                    {/* Emergency */}
                    <div className="border-t pt-4 mt-2">
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Emergency Contact</p>
                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={form.control} name="emergencyContact" render={({ field }) => (
                          <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <FormField control={form.control} name="emergencyPhone" render={({ field }) => (
                          <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                      </div>
                    </div>

                    <div className="pt-4 flex justify-end gap-2">
                      <Button variant="ghost" type="button" onClick={() => setIsEditing(false)}>Cancel</Button>
                      <Button type="submit" disabled={updateMutation.isPending} className="font-heading uppercase">
                        <Save size={16} className="mr-2" /> Save Profile
                      </Button>
                    </div>
                  </form>
                </Form>
              ) : (
                <div className="space-y-6">
                  {/* Contact */}
                  <div className="grid grid-cols-2 gap-y-5">
                    <InfoRow label="Email" value={rider.email} />
                    <InfoRow label="Phone" value={rider.phone} />
                    <InfoRow label="Hometown" value={r.hometown} />
                    <InfoRow label="Date of Birth" value={rider.dateOfBirth} />
                  </div>

                  {/* Racing */}
                  <div className="border-t pt-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Racing Info</p>
                    <div className="grid grid-cols-2 gap-y-5">
                      <InfoRow label="Bike Manufacturer" value={r.bikeManufacturer} />
                      <InfoRow label="Default Bib #" value={rider.bibNumber} />
                      <InfoRow label="AMA #" value={r.amaNumber} />
                      <InfoRow label="MyLaps Transponder #" value={r.mylapsTransponderId} />
                    </div>
                    {r.sponsors && (
                      <div className="mt-5">
                        <InfoRow label="Sponsors" value={r.sponsors} />
                      </div>
                    )}
                  </div>

                  {/* Emergency */}
                  <div className="border-t pt-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Emergency Contact</p>
                    <div className="grid grid-cols-2 gap-y-5">
                      <InfoRow label="Name" value={rider.emergencyContact} />
                      <InfoRow label="Phone" value={rider.emergencyPhone} />
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Sponsors callout (read view) */}
          {!isEditing && r.sponsors && (
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="p-5 flex items-start gap-3">
                <Star size={18} className="text-primary mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-bold text-primary uppercase tracking-widest mb-1">Sponsors</div>
                  <div className="font-medium">{r.sponsors}</div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent Results */}
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
                <History className="text-primary" size={20} /> Recent Results
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {rider.recentResults && rider.recentResults.length > 0 ? (
                <div className="divide-y">
                  {rider.recentResults.map((result, i) => (
                    <div key={i} className="p-4 flex items-center justify-between hover:bg-muted/30 transition-colors">
                      <div>
                        <div className="font-heading font-bold text-lg">{result.raceClass}</div>
                        <div className="text-sm text-muted-foreground flex items-center gap-2">
                          <Activity size={14} /> Moto {result.motoId}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-heading font-bold text-primary">
                          {result.position === 1 ? "1st" : result.position === 2 ? "2nd" : result.position === 3 ? "3rd" : `${result.position}th`}
                        </div>
                        {result.points !== null && (
                          <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{result.points} PTS</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-muted-foreground">No recent race results on record.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* RFID */}
          <Card className={rider.rfidNumber ? "border-secondary" : "border-destructive/30"}>
            <CardHeader className={`${rider.rfidNumber ? "bg-secondary/5" : "bg-destructive/5"} border-b pb-4`}>
              <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
                <Tag className={rider.rfidNumber ? "text-secondary" : "text-destructive"} size={20} />
                RFID Status
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              {rider.rfidNumber ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-center p-6 bg-secondary/10 rounded-lg border border-secondary/20">
                    <div className="text-center">
                      <div className="text-xs font-bold text-secondary uppercase tracking-widest mb-2">Active Tag</div>
                      <div className="font-mono text-xl font-bold text-secondary break-all">{rider.rfidNumber}</div>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground text-center">Used for automatic RFID check-in at events.</p>
                </div>
              ) : (
                <div className="flex items-center justify-center p-6 bg-destructive/10 rounded-lg border border-destructive/20">
                  <div className="text-center">
                    <div className="text-xs font-bold text-destructive uppercase tracking-widest mb-2">No Tag Assigned</div>
                    <div className="text-sm text-destructive/80 font-medium">Manual check-in required</div>
                  </div>
                </div>
              )}
              <div className="mt-6 pt-6 border-t space-y-3">
                <label className="text-sm font-bold uppercase tracking-wider block">Assign New Tag</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Scan or enter RFID #..."
                    value={rfidInput}
                    onChange={(e) => setRfidInput(e.target.value)}
                    className="font-mono"
                  />
                  <Button onClick={handleAssignRfid} disabled={!rfidInput || assignRfidMutation.isPending} className="font-heading uppercase">
                    Assign
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* MyLaps quick view */}
          {r.mylapsTransponderId && (
            <Card>
              <CardContent className="p-5 space-y-1">
                <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">MyLaps Transponder</div>
                <div className="font-mono text-lg font-bold">{r.mylapsTransponderId}</div>
              </CardContent>
            </Card>
          )}

          {/* AMA quick view */}
          {r.amaNumber && (
            <Card>
              <CardContent className="p-5 space-y-1">
                <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">AMA Membership #</div>
                <div className="font-mono text-lg font-bold">{r.amaNumber}</div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
