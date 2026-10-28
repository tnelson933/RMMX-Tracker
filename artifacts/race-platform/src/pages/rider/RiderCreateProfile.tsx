import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { BikeBrandChips } from "@/components/BikeBrandChips";
import { riderApi, type CreateProfilePayload } from "@/lib/rider-api";

const BIKE_BRANDS = [
  { name: "KTM",       color: "#FF6600", text: "#ffffff" },
  { name: "Honda",     color: "#CC0000", text: "#ffffff" },
  { name: "Gas Gas",   color: "#E30613", text: "#ffffff" },
  { name: "Husqvarna", color: "#F5C222", text: "#000000" },
  { name: "Yamaha",    color: "#003087", text: "#ffffff" },
  { name: "Kawasaki",  color: "#3D9B35", text: "#ffffff" },
  { name: "Suzuki",    color: "#FFDE00", text: "#000000" },
  { name: "Beta",      color: "#E8220D", text: "#ffffff" },
] as const;

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

export default function RiderCreateProfile() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<CreateProfilePayload>({
    firstName: "",
    lastName: "",
    phone: "",
    dateOfBirth: "",
    bibNumber: "",
    amaNumber: "",
    bikeManufacturer: "",
    sponsors: "",
    hometown: "",
    homeState: "",
    myLapsTransponderNumber: "",
  });

  function set(key: keyof CreateProfilePayload, value: string) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("First and last name are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const newRider = await riderApi.createProfile(form);
      queryClient.invalidateQueries({ queryKey: ["rider-profiles"] });
      navigate(`/rider/portal/${newRider.id}?tab=profile`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const field = (
    label: string,
    key: keyof CreateProfilePayload,
    placeholder?: string,
    type = "text",
  ) => (
    <div className="space-y-1.5">
      <Label className="font-medium text-[#333]">{label}</Label>
      <Input
        type={type}
        value={String(form[key] ?? "")}
        onChange={e => set(key, e.target.value)}
        placeholder={placeholder}
        className="h-9 text-sm"
      />
    </div>
  );

  return (
    <RiderLayout
      showBack
      backTo="/rider/portal"
      backLabel="My Profiles"
      title="New Profile"
      subtitle="Add a rider profile linked to your account. You can fill in more details after creating it."
    >
      <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">

        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>
        )}

        {/* Name — required */}
        <Card>
          <CardHeader className="px-6 py-4 border-b-2 border-[#ECECEC]">
            <CardTitle className="font-heading font-extrabold text-lg uppercase tracking-[0.5px] text-[#242424] flex items-center gap-2">
              <span aria-hidden className="w-[4px] h-5 bg-primary -skew-x-[18deg] shrink-0" /> Rider Name <span className="text-destructive">*</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 grid grid-cols-2 gap-4">
            {field("First Name", "firstName", "First name")}
            {field("Last Name", "lastName", "Last name")}
            {field("Date of Birth", "dateOfBirth", "YYYY-MM-DD")}
            {field("Phone", "phone", "555-867-5309")}
          </CardContent>
        </Card>

        {/* Racing info — optional */}
        <Card>
          <CardHeader className="px-6 py-4 border-b-2 border-[#ECECEC]">
            <CardTitle className="font-heading font-extrabold text-lg uppercase tracking-[0.5px] text-[#242424] flex items-center gap-2">
              <span aria-hidden className="w-[4px] h-5 bg-primary -skew-x-[18deg] shrink-0" /> Racing Info <span className="font-sans text-[13px] font-normal normal-case tracking-normal text-muted-foreground">(optional)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {field("#", "bibNumber", "e.g. 42")}
              {field("AMA Number", "amaNumber", "AMA membership #")}
              {field("RM TrackR Transponder #", "myLapsTransponderNumber", "e.g. 4012345")}
            </div>

            <div className="space-y-1.5">
              <Label className="font-medium text-[#333]">Bike Brand</Label>
              <div className="mt-1">
                <BikeBrandChips brands={BIKE_BRANDS} value={form.bikeManufacturer} onChange={v => set("bikeManufacturer", v)} />
              </div>
              <input
                type="text"
                placeholder="Other brand (e.g. Sherco, TM, Rieju…)"
                value={BIKE_BRANDS.some(b => b.name === form.bikeManufacturer) ? "" : (form.bikeManufacturer ?? "")}
                onChange={e => set("bikeManufacturer", e.target.value)}
                className="mt-3 w-full rounded-none border-2 border-input bg-background px-3 text-base placeholder:text-muted-foreground focus:outline-none focus:border-foreground"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="font-medium text-[#333]">Sponsors</Label>
              <Textarea
                value={String(form.sponsors ?? "")}
                onChange={e => set("sponsors", e.target.value)}
                placeholder="e.g. Local Moto Shop, Fox Racing"
                className="text-sm min-h-[64px] resize-none"
              />
            </div>
          </CardContent>
        </Card>

        {/* Location — optional */}
        <Card>
          <CardHeader className="px-6 py-4 border-b-2 border-[#ECECEC]">
            <CardTitle className="font-heading font-extrabold text-lg uppercase tracking-[0.5px] text-[#242424] flex items-center gap-2">
              <span aria-hidden className="w-[4px] h-5 bg-primary -skew-x-[18deg] shrink-0" /> Location <span className="font-sans text-[13px] font-normal normal-case tracking-normal text-muted-foreground">(optional)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 grid grid-cols-2 gap-4">
            {field("Hometown", "hometown", "City")}
            <div className="space-y-1.5">
              <Label className="font-medium text-[#333]">Home State</Label>
              <select
                value={form.homeState ?? ""}
                onChange={e => set("homeState", e.target.value)}
                className="h-[52px] w-full rounded-none border-2 border-input bg-background px-3 text-base focus:outline-none focus:border-foreground"
              >
                <option value="">Select state…</option>
                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3 pb-8">
          <Button type="submit" disabled={saving} className="min-h-[52px] px-8 text-base bg-[#242424] border-[#242424] text-white hover:bg-black">
            {saving
              ? <><Loader2 size={14} className="animate-spin mr-2" /> Creating…</>
              : <><Check size={14} className="mr-2" /> Create Profile</>
            }
          </Button>
          <Button type="button" variant="outline" className="min-h-[52px] px-8 text-base border-2 border-[#8C8C8C] bg-white text-[#333] hover:bg-[#F2F2F2] hover:border-[#333]" onClick={() => navigate("/rider/portal")} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </RiderLayout>
  );
}
