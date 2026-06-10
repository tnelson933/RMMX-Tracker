import { useState, useMemo, useEffect, useRef } from "react";
import { useRoute, useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Trophy, Clock, Star, ChevronDown, ChevronUp,
  Flag, AlertTriangle, Calendar, MapPin, Hash, User, Timer,
  Wifi, Pencil, Check, X, Loader2, Radio, DoorOpen,
  Navigation, LocateFixed, ExternalLink, LayoutList, LayoutGrid,
  Settings, Phone, Shield, Bike, Ribbon
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  riderApi,
  type RiderHistoryResponse,
  type RiderFull,
  type UpdateProfilePayload,
  type EventHistory,
  type MotoResult,
  type RiderPracticeResponse,
  type PracticeSessionHistory,
  type RiderScheduleResponse,
  type ScheduleEvent,
  type ScheduleMoto,
  type ScheduleFamilyGate,
  type ScheduleRegistration,
  type RiderEventPracticeResponse,
  type EventPracticeEvent,
  type EventPracticeSession,
  type EventPracticeLeaderboardEntry,
  type PracticeLeaderboardEntry,
} from "@/lib/rider-api";

function positionBadge(pos: number) {
  if (pos === 1) return "bg-yellow-400/20 text-yellow-600 border-yellow-400/40";
  if (pos === 2) return "bg-slate-200/40 text-slate-600 border-slate-300/60";
  if (pos === 3) return "bg-amber-500/20 text-amber-700 border-amber-400/40";
  return "bg-muted text-muted-foreground border-border";
}

function formatMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const dec = Math.floor((ms % 1000) / 10);
  return `${mins}:${String(secs).padStart(2, "0")}.${String(dec).padStart(2, "0")}`;
}

// ─── RFID editor ────────────────────────────────────────────────────────────

function RfidEditor({ riderId, currentRfid }: { riderId: number; currentRfid: string | null }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentRfid ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setValue(currentRfid ?? "");
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await riderApi.updateRfid(riderId, value.trim() || null);
      queryClient.invalidateQueries({ queryKey: ["rider-history", riderId] });
      queryClient.invalidateQueries({ queryKey: ["rider-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["rider-practice", riderId] });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5 mt-2">
        <div className="flex items-center gap-2">
          <Wifi size={13} className="text-muted-foreground shrink-0" />
          <Input
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="e.g. AB12CD34"
            className="h-8 text-sm font-mono w-48"
            autoFocus
            onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
          />
          <Button size="sm" className="h-8 px-2" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={cancel} disabled={saving}>
            <X size={13} />
          </Button>
        </div>
        {error && <p className="text-xs text-destructive ml-5">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <Wifi size={13} className="text-muted-foreground shrink-0" />
      {currentRfid ? (
        <span className="text-sm font-mono text-muted-foreground">{currentRfid}</span>
      ) : (
        <span className="text-sm text-muted-foreground italic">No transponder set</span>
      )}
      <button
        onClick={startEdit}
        className="ml-1 text-muted-foreground hover:text-primary transition-colors"
        title="Edit transponder number"
      >
        <Pencil size={11} />
      </button>
    </div>
  );
}

// ─── Profile editor ─────────────────────────────────────────────────────────

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

function ProfileEditor({ rider }: { rider: RiderFull }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<UpdateProfilePayload>({
    firstName: rider.firstName,
    lastName: rider.lastName,
    phone: rider.phone ?? "",
    dateOfBirth: rider.dateOfBirth ?? "",
    emergencyContact: rider.emergencyContact ?? "",
    emergencyPhone: rider.emergencyPhone ?? "",
    bibNumber: rider.bibNumber ?? "",
    amaNumber: rider.amaNumber ?? "",
    bikeManufacturer: rider.bikeManufacturer ?? "",
    sponsors: rider.sponsors ?? "",
    hometown: rider.hometown ?? "",
    homeState: rider.homeState ?? "",
    myLapsTransponderNumber: rider.myLapsTransponderNumber ?? "",
  });

  function startEdit() {
    setForm({
      firstName: rider.firstName,
      lastName: rider.lastName,
      phone: rider.phone ?? "",
      dateOfBirth: rider.dateOfBirth ?? "",
      emergencyContact: rider.emergencyContact ?? "",
      emergencyPhone: rider.emergencyPhone ?? "",
      bibNumber: rider.bibNumber ?? "",
      amaNumber: rider.amaNumber ?? "",
      bikeManufacturer: rider.bikeManufacturer ?? "",
      sponsors: rider.sponsors ?? "",
      hometown: rider.hometown ?? "",
      homeState: rider.homeState ?? "",
      myLapsTransponderNumber: rider.myLapsTransponderNumber ?? "",
    });
    setError(null);
    setSaved(false);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  function set(key: keyof UpdateProfilePayload, value: string) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function save() {
    if (!form.firstName?.trim() || !form.lastName?.trim()) {
      setError("First and last name are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await riderApi.updateProfile(rider.id, form);
      queryClient.invalidateQueries({ queryKey: ["rider-history", rider.id] });
      queryClient.invalidateQueries({ queryKey: ["rider-profiles"] });
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const field = (label: string, key: keyof UpdateProfilePayload, placeholder?: string) => (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</Label>
      {editing ? (
        <Input
          value={String(form[key] ?? "")}
          onChange={e => set(key, e.target.value)}
          placeholder={placeholder}
          className="h-9 text-sm"
        />
      ) : (
        <p className="text-sm py-1.5 px-0 min-h-[2rem]">
          {String(rider[key as keyof RiderFull] ?? "") || <span className="text-muted-foreground italic">Not set</span>}
        </p>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h2 className="font-heading font-bold text-lg uppercase tracking-wide">Profile Information</h2>
        {!editing ? (
          <div className="flex items-center gap-2">
            {saved && (
              <span className="flex items-center gap-1 text-sm text-green-600 font-medium">
                <Check size={14} /> Saved
              </span>
            )}
            <Button size="sm" variant="outline" onClick={startEdit}>
              <Pencil size={13} className="mr-1.5" /> Edit Profile
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={13} className="animate-spin mr-1.5" /> : <Check size={13} className="mr-1.5" />}
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>
      )}

      {/* Personal */}
      <Card>
        <CardHeader className="pb-3 pt-4 px-5">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <User size={13} /> Personal
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 grid grid-cols-2 gap-4">
          {field("First Name", "firstName", "First name")}
          {field("Last Name", "lastName", "Last name")}
          {field("Phone", "phone", "e.g. 555-867-5309")}
          {field("Date of Birth", "dateOfBirth", "YYYY-MM-DD")}
          {field("Hometown", "hometown", "City")}
          {field("Home State", "homeState", "e.g. AZ")}
        </CardContent>
      </Card>

      {/* Racing */}
      <Card>
        <CardHeader className="pb-3 pt-4 px-5">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Trophy size={13} /> Racing Info
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 grid grid-cols-2 gap-4">
          {field("#", "bibNumber", "e.g. 42")}
          {field("AMA Number", "amaNumber", "AMA membership #")}
          {field("MyLaps Transponder #", "myLapsTransponderNumber", "e.g. 4012345")}
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bike Brand</Label>
            {editing ? (
              <>
                <div className="grid grid-cols-4 gap-2 mt-1">
                  {BIKE_BRANDS.map(brand => {
                    const selected = form.bikeManufacturer === brand.name;
                    return (
                      <button
                        key={brand.name}
                        type="button"
                        onClick={() => set("bikeManufacturer", selected ? "" : brand.name)}
                        className="rounded-md px-2 py-3 text-sm font-bold font-heading uppercase tracking-wide transition-all border-2"
                        style={selected
                          ? { backgroundColor: brand.color, color: brand.text, borderColor: brand.color }
                          : { backgroundColor: "transparent", color: "inherit", borderColor: brand.color + "60" }
                        }
                      >
                        {brand.name}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  placeholder="Other brand (e.g. Sherco, TM, Rieju…)"
                  value={BIKE_BRANDS.some(b => b.name === form.bikeManufacturer) ? "" : (form.bikeManufacturer ?? "")}
                  onChange={e => set("bikeManufacturer", e.target.value)}
                  className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </>
            ) : (
              <p className="text-sm py-1.5 min-h-[2rem]">
                {(() => {
                  const b = BIKE_BRANDS.find(b => b.name === rider.bikeManufacturer);
                  return b
                    ? <span className="inline-block rounded px-2 py-0.5 text-xs font-bold font-heading uppercase tracking-wide" style={{ backgroundColor: b.color, color: b.text }}>{b.name}</span>
                    : rider.bikeManufacturer || <span className="text-muted-foreground italic">Not set</span>;
                })()}
              </p>
            )}
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sponsors</Label>
            {editing ? (
              <Textarea
                value={String(form.sponsors ?? "")}
                onChange={e => set("sponsors", e.target.value)}
                placeholder="e.g. Local Moto Shop, Fox Racing"
                className="text-sm min-h-[72px] resize-none"
              />
            ) : (
              <p className="text-sm py-1.5 min-h-[2rem]">
                {rider.sponsors || <span className="text-muted-foreground italic">Not set</span>}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Emergency contact */}
      <Card>
        <CardHeader className="pb-3 pt-4 px-5">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Shield size={13} /> Emergency Contact
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 grid grid-cols-2 gap-4">
          {field("Contact Name", "emergencyContact", "Full name")}
          {field("Contact Phone", "emergencyPhone", "e.g. 555-867-5309")}
        </CardContent>
      </Card>

      {/* Email note */}
      <p className="text-xs text-muted-foreground px-1">
        Email address cannot be changed here — it's your account login and links your race history.
        To update email, contact the race organizer.
      </p>
    </div>
  );
}

// ─── Race history components ────────────────────────────────────────────────

function MotoRow({ moto }: { moto: MotoResult }) {
  const [lapOpen, setLapOpen] = useState(false);
  const hasTimes = moto.lapTimes && moto.lapTimes.length > 0;

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 bg-muted/30">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{moto.motoName}</span>
            <Badge variant="outline" className="text-xs capitalize">{moto.motoType}</Badge>
          </div>
        </div>

        <div className="flex items-center gap-4 text-sm flex-shrink-0">
          {moto.dnf ? (
            <Badge variant="destructive" className="text-xs font-bold">DNF</Badge>
          ) : moto.dns ? (
            <Badge variant="outline" className="text-xs text-muted-foreground">DNS</Badge>
          ) : (
            <Badge variant="outline" className={`text-xs font-heading font-bold border ${positionBadge(moto.position)}`}>
              P{moto.position}
            </Badge>
          )}

          {moto.points !== null && !moto.dnf && !moto.dns && (
            <span className="flex items-center gap-1 text-primary font-bold text-sm">
              <Star size={12} /> {moto.points}
            </span>
          )}

          {moto.totalTime && (
            <span className="flex items-center gap-1 text-muted-foreground font-mono text-xs">
              <Clock size={11} /> {moto.totalTime}
            </span>
          )}

          {hasTimes && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setLapOpen((v) => !v)}
            >
              {lapOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              <span className="ml-1">{moto.lapTimes.length} laps</span>
            </Button>
          )}
        </div>
      </div>

      {lapOpen && hasTimes && (
        <div className="px-4 py-3 bg-background border-t">
          <div className="text-xs text-muted-foreground mb-2 font-heading uppercase tracking-wider">Lap Times</div>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {moto.lapTimes.map((t, i) => (
              <div key={i} className="bg-muted rounded px-2 py-1.5 text-center">
                <div className="text-xs text-muted-foreground">Lap {i + 1}</div>
                <div className="font-mono text-xs font-medium">{t}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EventCard({ event }: { event: EventHistory }) {
  const [open, setOpen] = useState(true);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="font-heading font-bold text-lg uppercase tracking-tight">
              {event.eventName}
            </CardTitle>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <Calendar size={13} />
                {event.eventDate ? new Date(event.eventDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "—"}
              </span>
              {(event.eventLocation || event.eventState) && (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <MapPin size={13} />
                  {event.eventLocation ?? event.eventState}
                </span>
              )}
              <Badge variant="secondary" className="text-xs">{event.raceClass}</Badge>
              {event.timingTechnology && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Timer size={11} />
                  {event.timingTechnology === "mylaps" ? "Timed with MyLaps" : "Timed with RFID"}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 flex-shrink-0">
            {event.bestPosition !== null && (
              <div className="text-center">
                <div className="text-xs text-muted-foreground mb-0.5">Best</div>
                <Badge variant="outline" className={`font-heading font-bold border ${positionBadge(event.bestPosition)}`}>
                  P{event.bestPosition}
                </Badge>
              </div>
            )}
            <div className="text-center">
              <div className="text-xs text-muted-foreground mb-0.5">Points</div>
              <div className="font-heading font-bold text-primary text-lg">{event.totalPoints}</div>
            </div>
            {open ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 space-y-2">
          {event.motos.map((moto) => (
            <MotoRow key={moto.motoId} moto={moto} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Event practice components ────────────────────────────────────────────────

function EventPracticeSessionCard({ session, riderId }: { session: EventPracticeSession; riderId: number }) {
  const [showMyLaps, setShowMyLaps] = useState(false);
  const [liveLeaderboard, setLiveLeaderboard] = useState<EventPracticeLeaderboardEntry[] | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const isLive = session.status === "in_progress";

  useEffect(() => {
    if (!isLive) return;
    const es = new EventSource(`/api/timing/live/${session.motoId}`);
    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (!data?.leaderboard) return;
        // Re-rank by fastest single lap — this is gate pick order
        const sorted = [...data.leaderboard].sort((a: any, b: any) => {
          if (a.bestLapMs == null && b.bestLapMs == null) return 0;
          if (a.bestLapMs == null) return 1;
          if (b.bestLapMs == null) return -1;
          return a.bestLapMs - b.bestLapMs;
        });
        setLiveLeaderboard(
          sorted.map((r: any, i: number) => ({
            rank: i + 1,
            riderId: r.riderId,
            riderName: r.riderName,
            bibNumber: r.bibNumber ?? null,
            bestLapMs: r.bestLapMs ?? null,
            lapCount: r.laps ?? 0,
            isMe: r.riderId === riderId,
          }))
        );
        setSseConnected(true);
      } catch { /* ignore parse errors */ }
    };
    return () => {
      es.close();
      setSseConnected(false);
    };
  }, [session.motoId, isLive, riderId]);

  const rawLeaderboard = liveLeaderboard ?? session.leaderboard;
  const displayLeaderboard = [...rawLeaderboard]
    .sort((a, b) => {
      if (a.bestLapMs == null && b.bestLapMs == null) return 0;
      if (a.bestLapMs == null) return 1;
      if (b.bestLapMs == null) return -1;
      return a.bestLapMs - b.bestLapMs;
    })
    .map((e, i) => ({ ...e, rank: i + 1 }));
  const myEntry = displayLeaderboard.find(e => e.isMe);
  const myLapsWithTime = session.myLaps.filter(l => l.lapTimeMs !== null && l.lapTimeMs > 0);

  return (
    <Card>
      <CardHeader className="py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Timer size={14} className="text-primary shrink-0" />
            <CardTitle className="font-heading font-bold text-base uppercase tracking-tight truncate">
              {session.sessionName}
            </CardTitle>
          </div>
          {isLive ? (
            <span className={`flex items-center gap-1.5 text-xs font-bold uppercase px-2.5 py-1 rounded-full border shrink-0 ${
              sseConnected
                ? "text-primary bg-primary/10 border-primary/20"
                : "text-muted-foreground bg-muted border-border"
            }`}>
              <Radio size={10} className={sseConnected ? "animate-pulse" : ""} />
              {sseConnected ? "Live" : "Connecting…"}
            </span>
          ) : (
            <Badge variant="outline" className="text-xs shrink-0">Done</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
          <Trophy size={11} />
          Gate pick order — ranked by fastest single lap
        </div>

        {displayLeaderboard.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No lap times recorded yet</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="grid grid-cols-[2.25rem_1fr_2.75rem_5rem] gap-2 px-3 py-2 bg-muted/50 border-b border-border">
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Pick</div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Rider</div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Laps</div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Best Lap</div>
            </div>
            {displayLeaderboard.map((entry: EventPracticeLeaderboardEntry) => (
              <div
                key={entry.rank}
                className={`grid grid-cols-[2.25rem_1fr_2.75rem_5rem] gap-2 items-center px-3 py-2.5 border-b border-border/50 last:border-b-0 ${
                  entry.isMe ? "bg-primary/10 border-l-2 border-l-primary" : ""
                }`}
              >
                <div className="text-center">
                  {entry.rank === 1 ? (
                    <Trophy size={13} className="text-primary mx-auto" />
                  ) : (
                    <span className="text-xs font-mono font-bold text-muted-foreground">{entry.rank}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-sm truncate ${entry.isMe ? "font-bold text-primary" : "text-foreground"}`}>
                    {entry.riderName}
                  </span>
                  {entry.bibNumber && (
                    <span className="text-xs text-muted-foreground shrink-0 hidden xs:inline">#{entry.bibNumber}</span>
                  )}
                  {entry.isMe && (
                    <Badge className="text-[10px] px-1.5 py-0 h-4 leading-none shrink-0">You</Badge>
                  )}
                </div>
                <div className="text-center text-sm font-heading font-bold text-foreground">{entry.lapCount}</div>
                <div className={`text-center font-mono text-sm font-bold ${entry.isMe || entry.rank === 1 ? "text-primary" : "text-foreground"}`}>
                  {formatMs(entry.bestLapMs)}
                </div>
              </div>
            ))}
          </div>
        )}

        {myLapsWithTime.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowMyLaps(v => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              {showMyLaps ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              My lap times ({myLapsWithTime.length})
            </button>
            {showMyLaps && (
              <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                {myLapsWithTime.map((lap) => {
                  const isBest = lap.lapTimeMs === myEntry?.bestLapMs;
                  return (
                    <div
                      key={lap.lapNumber}
                      className={`rounded px-2 py-2 text-center border ${
                        isBest ? "bg-primary/10 border-primary/30" : "bg-muted border-transparent"
                      }`}
                    >
                      <div className="text-xs text-muted-foreground">Lap {lap.lapNumber}</div>
                      <div className={`font-mono text-xs font-bold mt-0.5 ${isBest ? "text-primary" : ""}`}>
                        {formatMs(lap.lapTimeMs)}
                      </div>
                      {isBest && <div className="text-xs text-primary font-bold mt-0.5">Best</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EventPracticePanel({
  events,
  loading,
  riderId,
}: {
  events: EventPracticeEvent[];
  loading: boolean;
  riderId: number;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map(i => (
          <div key={i} className="h-32 bg-muted animate-pulse rounded-xl" />
        ))}
      </div>
    );
  }

  const eventsWithSessions = events.filter(e => e.sessions.length > 0);

  if (eventsWithSessions.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <Flag size={40} className="mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground text-sm">No event practice sessions yet</p>
          <p className="text-muted-foreground text-xs mt-1 max-w-xs mx-auto">
            Once an organizer runs a practice session at an event you're registered for, your gate pick ranking will appear here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {eventsWithSessions.map(event => (
        <div key={event.eventId}>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Flag size={13} className="text-primary shrink-0" />
            <h3 className="font-heading font-bold uppercase tracking-wider text-sm text-foreground">
              {event.eventName}
            </h3>
            {event.raceClass && (
              <Badge variant="outline" className="text-xs">{event.raceClass}</Badge>
            )}
            {event.eventDate && (
              <span className="text-xs text-muted-foreground">
                {new Date(event.eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            )}
          </div>
          <div className="space-y-3">
            {event.sessions.map(session => (
              <EventPracticeSessionCard key={session.motoId} session={session} riderId={riderId} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Open practice history components ─────────────────────────────────────────

function PracticeSessionCard({ session }: { session: PracticeSessionHistory }) {
  const [open, setOpen] = useState(false);
  const lapsWithTime = session.laps.filter(l => l.lapTimeMs !== null && l.lapTimeMs > 0);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none py-4"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Timer size={15} className="text-primary shrink-0" />
              <CardTitle className="font-heading font-bold text-base uppercase tracking-tight truncate">
                {session.sessionName}
              </CardTitle>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {session.startedAt && (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Calendar size={13} />
                  {new Date(session.startedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                </span>
              )}
              {session.startedAt && (
                <span className="text-xs text-muted-foreground">
                  {new Date(session.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-5 flex-shrink-0">
            <div className="text-center">
              <div className="text-xs text-muted-foreground mb-0.5">Laps</div>
              <div className="font-heading font-bold text-xl">{session.lapCount}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground mb-0.5">Best Lap</div>
              <div className="font-mono font-bold text-primary text-sm">
                {formatMs(session.bestLapMs)}
              </div>
            </div>
            {open ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>

      {open && lapsWithTime.length > 0 && (
        <CardContent className="pt-0">
          <div className="border-t pt-3">
            <div className="text-xs text-muted-foreground mb-3 font-heading uppercase tracking-wider">
              Lap Times
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {lapsWithTime.map((lap) => {
                const isBest = lap.lapTimeMs === session.bestLapMs;
                return (
                  <div
                    key={lap.lapNumber}
                    className={`rounded px-2 py-2 text-center border ${
                      isBest
                        ? "bg-primary/10 border-primary/30"
                        : "bg-muted border-transparent"
                    }`}
                  >
                    <div className="text-xs text-muted-foreground">Lap {lap.lapNumber}</div>
                    <div className={`font-mono text-xs font-bold mt-0.5 ${isBest ? "text-primary" : ""}`}>
                      {formatMs(lap.lapTimeMs)}
                    </div>
                    {isBest && (
                      <div className="text-xs text-primary font-bold mt-0.5">Best</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      )}

      {open && lapsWithTime.length === 0 && (
        <CardContent className="pt-0">
          <div className="border-t pt-3 text-center text-sm text-muted-foreground py-4">
            No timed laps recorded in this session
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Near Me tab ─────────────────────────────────────────────────────────────

const STATE_CENTROIDS: Record<string, [number, number]> = {
  AL:[32.318,-86.902],AK:[64.200,-153.493],AZ:[34.048,-111.093],AR:[34.799,-92.199],
  CA:[36.778,-119.417],CO:[39.550,-105.782],CT:[41.603,-73.087],DE:[38.910,-75.527],
  FL:[27.664,-81.515],GA:[32.165,-82.900],HI:[19.898,-155.665],ID:[44.068,-114.742],
  IL:[40.633,-89.398],IN:[40.267,-86.134],IA:[41.878,-93.097],KS:[38.526,-96.726],
  KY:[37.668,-84.670],LA:[31.169,-91.867],ME:[44.693,-69.381],MD:[39.045,-76.641],
  MA:[42.407,-71.382],MI:[44.314,-85.602],MN:[46.729,-94.685],MS:[32.354,-89.398],
  MO:[37.964,-91.831],MT:[46.879,-110.362],NE:[41.492,-99.901],NV:[38.802,-116.419],
  NH:[43.193,-71.572],NJ:[40.058,-74.405],NM:[34.519,-105.870],NY:[42.165,-74.948],
  NC:[35.630,-79.806],ND:[47.528,-99.784],OH:[40.417,-82.907],OK:[35.467,-97.516],
  OR:[43.804,-120.554],PA:[41.203,-77.194],RI:[41.680,-71.511],SC:[33.836,-81.163],
  SD:[43.969,-99.901],TN:[35.517,-86.580],TX:[31.968,-99.901],UT:[39.321,-111.093],
  VT:[44.558,-72.577],VA:[37.431,-78.656],WA:[47.751,-120.740],WV:[38.597,-80.454],
  WI:[43.784,-88.787],WY:[43.075,-107.290],
};

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface UpcomingEvent {
  eventId: number;
  name: string;
  state: string;
  date: string | null;
  location: string | null;
  trackName: string | null;
  status: string;
  clubName: string;
  dist?: number | null;
}

function statusLabel(s: string, date?: string | null) {
  const todayStr = new Date().toLocaleDateString("en-CA");
  const isToday = !!date && date.substring(0, 10) === todayStr;
  if (isToday && s !== "completed" && s !== "draft") return { label: "Race Day", cls: "bg-primary/15 text-primary border-primary/40" };
  if (s === "registration_open") return { label: "Registration Open", cls: "bg-green-500/15 text-green-700 border-green-400/40" };
  if (s === "race_day") return { label: "Race Day", cls: "bg-primary/15 text-primary border-primary/40" };
  return { label: s.replace(/_/g, " "), cls: "bg-muted text-muted-foreground border-border" };
}

function NearbyEventCard({ event }: { event: UpcomingEvent }) {
  const [, navigate] = useLocation();
  const { label, cls } = statusLabel(event.status, event.date);
  const canRegister = event.status === "registration_open";

  return (
    <div className={`rounded-xl border overflow-hidden ${canRegister ? "border-green-400/50 bg-green-500/5" : "border-border bg-card"}`}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-heading font-bold text-base uppercase tracking-tight leading-tight truncate">
              {event.name}
            </h3>
            <div className="flex items-center gap-2 mt-1 flex-wrap text-sm text-muted-foreground">
              {event.date && (
                <span className="flex items-center gap-1">
                  <Calendar size={12} />
                  {new Date(event.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </span>
              )}
              <span className="flex items-center gap-1">
                <MapPin size={12} />
                {event.location ?? event.state}
                {event.location && event.state && <span className="text-muted-foreground/60">, {event.state}</span>}
              </span>
            </div>
            {event.trackName && (
              <p className="text-xs text-muted-foreground mt-0.5">{event.trackName}</p>
            )}
            {event.clubName && (
              <p className="text-xs text-muted-foreground mt-0.5">{event.clubName}</p>
            )}
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <Badge variant="outline" className={`text-xs border ${cls}`}>{label}</Badge>
            {event.dist != null && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                <Navigation size={11} />
                ~{Math.round(event.dist).toLocaleString()} mi
              </span>
            )}
          </div>
        </div>

        {canRegister && (
          <Button
            className="w-full mt-3 font-heading uppercase tracking-wider gap-2"
            onClick={() => navigate(`/register/${event.eventId}`)}
          >
            <ExternalLink size={14} />
            Register Now
          </Button>
        )}
      </div>
    </div>
  );
}

function NearMeTab() {
  const [geoStatus, setGeoStatus] = useState<"idle" | "loading" | "granted" | "denied">("idle");
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);

  const { data: rawEvents = [], isLoading } = useQuery<UpcomingEvent[]>({
    queryKey: ["public-upcoming-nearbytab"],
    queryFn: () => fetch("/api/public/upcoming").then(r => r.json()),
    staleTime: 5 * 60_000,
  } as any);

  const events = useMemo<UpcomingEvent[]>(() => {
    if (!userCoords) return rawEvents as UpcomingEvent[];
    return (rawEvents as UpcomingEvent[])
      .map(e => {
        const centroid = STATE_CENTROIDS[e.state];
        const dist = centroid ? haversineMiles(userCoords.lat, userCoords.lng, centroid[0], centroid[1]) : null;
        return { ...e, dist };
      })
      .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
  }, [rawEvents, userCoords]);

  const requestLocation = () => {
    setGeoStatus("loading");
    navigator.geolocation.getCurrentPosition(
      pos => {
        setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoStatus("granted");
      },
      () => setGeoStatus("denied"),
      { timeout: 10_000 },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-28 bg-muted animate-pulse rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Location banner */}
      {geoStatus === "idle" && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
            <LocateFixed size={16} className="text-primary shrink-0" />
            <span>Allow location to sort by distance from you</span>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 font-heading uppercase text-xs tracking-wider" onClick={requestLocation}>
            Use My Location
          </Button>
        </div>
      )}
      {geoStatus === "loading" && (
        <div className="flex items-center gap-2 rounded-xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin shrink-0" />
          Getting your location…
        </div>
      )}
      {geoStatus === "granted" && (
        <div className="flex items-center gap-2 rounded-xl border border-green-400/40 bg-green-500/5 px-4 py-3 text-sm text-green-700">
          <LocateFixed size={14} className="shrink-0" />
          Sorted closest to farthest from your location
        </div>
      )}
      {geoStatus === "denied" && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-muted-foreground">
          <AlertTriangle size={14} className="text-destructive shrink-0" />
          Location access denied — showing all upcoming events
        </div>
      )}

      {events.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <MapPin size={40} className="mx-auto text-muted-foreground/30 mb-3" />
            <h3 className="font-heading font-bold text-lg uppercase mb-1">No Upcoming Events</h3>
            <p className="text-muted-foreground text-sm">Check back soon — new events are added regularly.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {events.map(e => <NearbyEventCard key={e.eventId} event={e} />)}
        </div>
      )}
    </div>
  );
}

// ─── Schedule components ──────────────────────────────────────────────────────

function formatCountdownMs(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function PracticeCountdown({ startedAt, timeLimitMs, variant = "badge" }: {
  startedAt: string | null;
  timeLimitMs: number | null;
  variant?: "badge" | "banner";
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!startedAt || !timeLimitMs) return null;
  const endMs = new Date(startedAt).getTime() + timeLimitMs;
  const remaining = endMs - now;
  const isExpired = remaining <= 0;

  if (variant === "badge") {
    if (isExpired) {
      return (
        <span className="flex items-center gap-1 text-xs font-bold text-destructive bg-destructive/10 border border-destructive/20 rounded-full px-2 py-0.5 animate-pulse shrink-0">
          <Timer size={9} /> Time&apos;s Up!
        </span>
      );
    }
    return (
      <span className={`flex items-center gap-1 text-xs font-bold rounded-full px-2 py-0.5 border shrink-0 ${
        remaining < 60000
          ? "text-destructive bg-destructive/10 border-destructive/20 animate-pulse"
          : remaining < 120000
          ? "text-primary bg-primary/10 border-primary/20"
          : "text-sky-600 bg-sky-500/10 border-sky-400/20"
      }`}>
        <Timer size={9} />
        <span className="font-mono tabular-nums">{formatCountdownMs(remaining)}</span>
      </span>
    );
  }

  // banner variant
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border text-sm font-medium ${
      isExpired
        ? "bg-destructive/10 border-destructive/30 text-destructive animate-pulse"
        : remaining < 60000
        ? "bg-destructive/10 border-destructive/30 text-destructive animate-pulse"
        : remaining < 120000
        ? "bg-primary/10 border-primary/30 text-primary"
        : "bg-sky-500/5 border-sky-400/20 text-sky-700 dark:text-sky-400"
    }`}>
      <Timer size={14} className="shrink-0" />
      <span className="flex-1 text-xs font-bold uppercase tracking-wider">
        {isExpired ? "Time's Up!" : "Time Remaining"}
      </span>
      {!isExpired && (
        <span className="font-mono font-bold tabular-nums text-base">{formatCountdownMs(remaining)}</span>
      )}
    </div>
  );
}

function motoStatusBadge(status: string) {
  if (status === "in_progress") return "bg-green-500/20 text-green-700 border-green-400/50";
  if (status === "completed") return "bg-muted text-muted-foreground border-border";
  return "bg-muted/50 text-muted-foreground border-border/50";
}

function motoTypeLabel(type: string) {
  if (type === "heat") return "Heat";
  if (type === "main") return "Main Event";
  if (type === "lcq") return "LCQ";
  if (type === "practice") return "Practice";
  return type;
}

function ScheduleMotoCard({ moto, isNowUp, isUpNext }: { moto: ScheduleMoto; isNowUp?: boolean; isUpNext?: boolean }) {
  const [open, setOpen] = useState(false);
  const isLive = moto.status === "in_progress";
  const isDone = moto.status === "completed";

  if (!moto.isAnyFamilyMemberInMoto) {
    // Collapsed title-only row — rider is NOT in this moto
    // Shows title + status badges, expands to reveal the full lineup
    return (
      <div className={`rounded-lg border overflow-hidden transition-colors ${
        isLive
          ? "border-green-400/60 bg-green-500/5"
          : isUpNext
          ? "border-primary/40 bg-primary/5"
          : isDone
          ? "border-border bg-muted/20 opacity-50"
          : "border-border bg-card"
      }`}>
        <button
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left"
        >
          <span className="font-mono text-xs text-muted-foreground w-5 text-center shrink-0">
            {moto.motoNumber}
          </span>
          <div className="flex-1 min-w-0">
            <span className={`text-sm font-medium truncate block ${isDone ? "text-muted-foreground" : "text-foreground"}`}>
              {moto.name}
            </span>
            {moto.type === "practice" ? (
              <span className="text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-500/10 text-sky-600 border border-sky-400/30 mr-1">Practice</span>
                {moto.raceClass ?? "All Classes"}
              </span>
            ) : moto.raceClass ? (
              <span className="text-xs text-muted-foreground">{moto.raceClass} · {motoTypeLabel(moto.type)}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {moto.scheduledTime && !isLive && !isDone && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono hidden sm:inline-flex">
                <Clock size={10} />
                {moto.scheduledTime}
              </span>
            )}
            {isLive && moto.type === "practice" && moto.timeLimitMs && (
              <PracticeCountdown startedAt={moto.startedAt} timeLimitMs={moto.timeLimitMs} variant="badge" />
            )}
            {(isLive || isNowUp) && (
              <span className="flex items-center gap-1 text-xs font-bold text-green-700 bg-green-500/15 border border-green-400/50 rounded-full px-2 py-0.5">
                <Radio size={9} className={isLive ? "animate-pulse" : undefined} /> Now Up
              </span>
            )}
            {isUpNext && !isLive && !isNowUp && (
              <span className="text-xs font-bold text-primary bg-primary/10 border border-primary/20 rounded-full px-2 py-0.5">
                Up Next
              </span>
            )}
            {isDone && !isLive && !isUpNext && (
              <Badge variant="outline" className="text-xs text-muted-foreground border-border">Done</Badge>
            )}
            {open ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
          </div>
        </button>

        {open && (
          <div className="border-t bg-background">
            {moto.lineup.length > 0 ? (
              <>
                <div className="px-4 pt-2 pb-1 text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground">
                  Gate Pick
                </div>
                <div className="divide-y">
                  {moto.lineup.map(entry => (
                    <div key={entry.gate} className="flex items-center gap-3 px-4 py-2">
                      <span className="w-7 h-7 rounded-full flex items-center justify-center font-heading font-bold text-xs shrink-0 bg-muted text-muted-foreground">
                        {entry.gate}
                      </span>
                      <span className="flex-1 text-sm text-foreground">{entry.riderName}</span>
                      {entry.bibNumber && (
                        <span className="text-xs font-mono text-muted-foreground">#{entry.bibNumber}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="px-4 py-3 text-sm text-muted-foreground text-center">
                Lineup not set yet
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Full-color card — at least one family member is in this moto
  return (
    <div className={`rounded-xl border-2 overflow-hidden ${
      isLive
        ? "border-green-500 shadow-lg shadow-green-500/10"
        : isDone
        ? "border-border"
        : "border-primary/60"
    }`}>
      {/* Header */}
      <div className={`px-4 py-3 flex items-center justify-between gap-3 ${
        isLive ? "bg-green-500 text-white" : isDone ? "bg-muted" : "bg-primary text-primary-foreground"
      }`}>
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {isLive && <Radio size={14} className="animate-pulse shrink-0" />}
          <span className="font-heading font-bold text-base uppercase tracking-tight">
            {moto.name}
          </span>
          <Badge className={`text-xs shrink-0 font-bold ${
            isLive
              ? "bg-white/20 text-white border-white/30"
              : isDone
              ? "bg-muted-foreground/20 text-muted-foreground border-border"
              : "bg-white/20 text-white border-white/30"
          } border`}>
            {isLive ? "Now Up" : isDone ? "Finished" : isNowUp ? "Now Up" : isUpNext ? "Up Next" : "Upcoming"}
          </Badge>
        </div>
        <button
          onClick={() => setOpen(v => !v)}
          className="shrink-0 opacity-80 hover:opacity-100 transition-opacity"
          aria-label="Toggle lineup"
        >
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {/* Gate highlight — one card per family member (or practice slot) */}
      {moto.type === "practice" ? (
        <>
          {/* Slot assignment or open practice */}
          <div className="px-4 py-3 bg-background border-b space-y-3">
            {moto.familyGates.length > 0 ? (
              <div className="space-y-3">
                {moto.familyGates.map(fg => {
                  const myEntry = (moto.practiceLeaderboard ?? []).find(e => e.isMe && e.riderId === fg.riderId);
                  return (
                    <div key={fg.riderId} className="flex items-center gap-3">
                      <div className="flex flex-col items-center justify-center w-14 h-14 rounded-xl bg-sky-500 text-white shrink-0">
                        <Timer size={12} className="mb-0.5 opacity-70" />
                        <span className="font-heading font-black text-xl leading-none">{fg.gate}</span>
                        <span className="text-[8px] font-bold uppercase tracking-wider opacity-70 mt-0.5">Slot</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-primary leading-tight">{fg.riderName}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {moto.raceClass ? <span className="font-medium text-foreground">{moto.raceClass} · </span> : null}
                          Practice Session{moto.lineup.length > 0 ? ` · ${moto.lineup.length} riders` : ""}
                        </div>
                        {myEntry && myEntry.bestLapMs ? (
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <span className={`inline-flex items-center gap-1 text-xs font-bold px-1.5 py-0.5 rounded border ${positionBadge(myEntry.rank)}`}>
                              P{myEntry.rank}
                            </span>
                            <span className="text-xs font-mono text-muted-foreground">
                              Best: <span className="font-bold text-foreground">{formatMs(myEntry.bestLapMs)}</span>
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-sky-500/10 text-sky-600 border border-sky-400/30">Practice</span>
                <span className="text-sm text-muted-foreground">Open to all checked-in riders</span>
                {moto.scheduledTime && !isLive && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono ml-auto">
                    <Clock size={11} /> {moto.scheduledTime}
                  </span>
                )}
              </div>
            )}

            {/* Time limit countdown */}
            {isLive && moto.timeLimitMs && (
              <PracticeCountdown startedAt={moto.startedAt} timeLimitMs={moto.timeLimitMs} variant="banner" />
            )}
          </div>

          {/* My lap times */}
          {(moto.practiceLaps?.length ?? 0) > 0 && (() => {
            const laps = moto.practiceLaps!;
            const bestMs = Math.min(...laps.map(l => l.lapTimeMs ?? Infinity));
            return (
              <div className="px-4 py-3 bg-background border-b">
                <div className="text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground mb-2">My Laps</div>
                <div className="flex flex-wrap gap-2">
                  {laps.map((lap, i) => {
                    const isPB = lap.lapTimeMs != null && lap.lapTimeMs === bestMs;
                    return (
                      <div key={i} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border ${
                        isPB
                          ? "bg-yellow-400/10 border-yellow-400/30 text-yellow-700 dark:text-yellow-400 font-bold"
                          : "bg-muted/50 border-border text-muted-foreground"
                      }`}>
                        <span className="text-[10px] uppercase tracking-wide opacity-60">L{lap.lapNumber}</span>
                        <span className="font-mono">{formatMs(lap.lapTimeMs)}</span>
                        {isPB && <span className="text-[9px] font-black uppercase text-yellow-600">PB</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>
      ) : (
      <div className="px-4 py-3 bg-background border-b">
        <div className="text-xs text-muted-foreground uppercase tracking-wider font-bold mb-2">
          {moto.familyGates.length === 1 ? "Gate Pick" : "Gate Picks"}
        </div>
        <div className="flex flex-wrap gap-3">
          {moto.familyGates.map(fg => (
            <div key={fg.riderId} className="flex items-center gap-3">
              <div className="flex flex-col items-center justify-center w-16 h-16 rounded-xl bg-foreground text-background shrink-0">
                <DoorOpen size={18} className="mb-0.5 opacity-70" />
                <span className="font-heading font-black text-2xl leading-none">{fg.gate}</span>
                <span className="text-[9px] font-bold uppercase tracking-wider opacity-60 mt-0.5">Gate Pick</span>
              </div>
              <div>
                <div className="text-sm font-bold text-primary leading-tight">{fg.riderName}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {moto.raceClass && <span className="text-foreground font-medium">{moto.raceClass}</span>}
                  {moto.raceClass && " · "}
                  {motoTypeLabel(moto.type)}
                  {moto.lapCount && <span> · {moto.lapCount} laps</span>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {moto.lineup.length} rider{moto.lineup.length !== 1 ? "s" : ""} in moto
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Expandable section */}
      {moto.type === "practice" ? (
        <>
          {open && (moto.practiceLeaderboard?.length ?? 0) > 0 && (
            <div className="bg-background">
              <div className="px-4 pt-3 pb-1 text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground">
                Session Leaderboard
              </div>
              <div className="divide-y">
                {(moto.practiceLeaderboard ?? []).map(entry => (
                  <div key={`${entry.riderId}-${entry.rank}`} className={`flex items-center gap-3 px-4 py-2.5 ${entry.isMe ? "bg-primary/5" : ""}`}>
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center font-heading font-bold text-xs shrink-0 border ${positionBadge(entry.rank)}`}>
                      {entry.rank}
                    </span>
                    <span className={`flex-1 text-sm ${entry.isMe ? "font-bold text-primary" : "font-medium text-foreground"}`}>
                      {entry.riderName}
                      {entry.isMe && <span className="text-[10px] text-primary ml-1.5 font-normal opacity-70">You</span>}
                    </span>
                    <span className={`text-xs font-mono shrink-0 ${entry.isMe ? "text-primary font-bold" : "text-muted-foreground"}`}>
                      {formatMs(entry.bestLapMs)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {open && (moto.practiceLeaderboard?.length ?? 0) === 0 && moto.lineup.length > 0 && (
            <div className="bg-background">
              <div className="px-4 pt-3 pb-1 text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground">
                Session Lineup
              </div>
              <div className="divide-y">
                {moto.lineup.map(entry => (
                  <div key={entry.gate} className={`flex items-center gap-3 px-4 py-2.5 ${entry.isFamilyMember ? "bg-primary/5" : ""}`}>
                    <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      entry.isFamilyMember ? "bg-sky-500 text-white" : "bg-muted text-muted-foreground"
                    }`}>{entry.gate}</span>
                    <span className={`flex-1 text-sm ${entry.isFamilyMember ? "font-bold text-primary" : "font-medium text-foreground"}`}>
                      {entry.riderName}
                    </span>
                    {entry.bibNumber && (
                      <span className="text-xs font-mono text-muted-foreground">#{entry.bibNumber}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {!open && ((moto.practiceLeaderboard?.length ?? 0) > 0 || moto.lineup.length > 0) && (
            <button
              onClick={() => setOpen(true)}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-2 transition-colors text-center border-t"
            >
              {(moto.practiceLeaderboard?.length ?? 0) > 0
                ? `${moto.practiceLeaderboard!.length} riders · tap to see leaderboard`
                : `${moto.lineup.length} riders · tap to expand`}
            </button>
          )}
        </>
      ) : (
        <>
          {open && moto.lineup.length > 0 && (
            <div className="bg-background">
              <div className="px-4 pt-3 pb-1 text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground">
                Gate Pick
              </div>
              <div className="divide-y">
                {moto.lineup.map(entry => (
                  <div
                    key={entry.gate}
                    className={`flex items-center gap-3 px-4 py-2.5 ${
                      entry.isFamilyMember ? "bg-primary/5" : ""
                    }`}
                  >
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center font-heading font-bold text-sm shrink-0 ${
                      entry.isFamilyMember
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {entry.gate}
                    </span>
                    <span className={`flex-1 text-sm ${
                      entry.isFamilyMember
                        ? "font-bold text-primary"
                        : "font-medium text-foreground"
                    }`}>
                      {entry.riderName}
                    </span>
                    {entry.bibNumber && (
                      <span className={`text-xs font-mono shrink-0 ${
                        entry.isFamilyMember ? "text-primary font-bold" : "text-muted-foreground"
                      }`}>
                        #{entry.bibNumber}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {!open && (
            <button
              onClick={() => setOpen(true)}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-2 transition-colors text-center border-t"
            >
              Show all {moto.lineup.length} riders · tap to expand
            </button>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_DISPLAY_ORDER: Record<string, number> = { in_progress: 0, scheduled: 1, completed: 2, cancelled: 3 };

function ScheduleEventSection({ event }: { event: ScheduleEvent }) {
  const todayStr = new Date().toLocaleDateString("en-CA");
  const isRaceDay = event.status === "race_day" || (
    event.status !== "completed" && event.status !== "draft" &&
    !!event.eventDate && event.eventDate.substring(0, 10) === todayStr
  );
  const hasLiveMotos = event.motos.some(m => m.status === "in_progress");
  const myMotos = event.motos.filter(m => m.isAnyFamilyMemberInMoto);
  const [collapsed, setCollapsed] = useState(false);
  const [showRunOrder, setShowRunOrder] = useState(false);

  // Re-sort for display: live → upcoming → completed, preserving motoNumber order within each group
  const sortedMotos = [...event.motos].sort((a, b) => {
    const oa = STATUS_DISPLAY_ORDER[a.status] ?? 1;
    const ob = STATUS_DISPLAY_ORDER[b.status] ?? 1;
    if (oa !== ob) return oa - ob;
    return (a.motoNumber ?? 0) - (b.motoNumber ?? 0);
  });

  // Strictly by motoNumber for the run order view
  const runOrderMotos = [...event.motos].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));

  // "Now Up" = rider's first upcoming moto in run order; "Up Next" = their second
  const myScheduled = event.motos
    .filter(m => m.isAnyFamilyMemberInMoto && !["completed", "cancelled", "in_progress"].includes(m.status))
    .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
  const nowUpMotoId = myScheduled[0]?.motoId ?? null;
  const upNextMotoId = myScheduled[1]?.motoId ?? null;

  // How many scheduled motos (by motoNumber) come before the rider's next moto.
  // in_progress motos don't count — they're already running and don't delay the rider.
  const nowUpMoto = myScheduled[0] ?? null;
  const nowUpMotoNum = nowUpMoto?.motoNumber ?? Infinity;
  const scheduledBefore = nowUpMoto
    ? event.motos.filter(m => m.status === "scheduled" && (m.motoNumber ?? 0) < nowUpMotoNum).length
    : null;
  const racesUntilTurn = scheduledBefore;

  const upcoming = sortedMotos.filter(m => m.status !== "completed" && m.status !== "cancelled");
  const finished = sortedMotos.filter(m => m.status === "completed" || m.status === "cancelled");

  return (
    <div className="rounded-2xl border-2 overflow-hidden shadow-sm">
      {/* Event header — prominent, clickable to collapse */}
      <button
        onClick={() => setCollapsed(v => !v)}
        className={`w-full text-left flex items-start gap-4 p-5 transition-colors ${
          isRaceDay
            ? hasLiveMotos
              ? "bg-green-600 text-white"
              : "bg-primary text-primary-foreground"
            : "bg-muted"
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-heading font-black text-xl uppercase tracking-tight leading-none">
              {event.eventName}
            </h3>
            {hasLiveMotos && (
              <span className="flex items-center gap-1 text-xs font-bold bg-white/20 text-white border border-white/30 rounded-full px-2 py-0.5">
                <Radio size={10} className="animate-pulse" /> Live
              </span>
            )}
          </div>
          <div className={`flex items-center gap-3 mt-1.5 flex-wrap text-sm ${isRaceDay ? "text-white/70" : "text-muted-foreground"}`}>
            {event.eventDate && (
              <span className="flex items-center gap-1">
                <Calendar size={12} />
                {new Date(event.eventDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </span>
            )}
            {(event.eventLocation || event.eventState) && (
              <span className="flex items-center gap-1">
                <MapPin size={12} />
                {event.eventLocation ?? event.eventState}
              </span>
            )}
          </div>
          {/* Family registrations — names + classes */}
          {event.registrations.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {event.registrations.map(r => (
                <span key={r.riderId} className={`inline-flex items-center gap-1 text-xs rounded-full px-2.5 py-0.5 font-semibold border ${
                  isRaceDay
                    ? "bg-white/15 text-white border-white/25"
                    : "bg-primary/10 text-primary border-primary/20"
                }`}>
                  {r.riderName}{r.raceClass ? ` · ${r.raceClass}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right">
            {racesUntilTurn !== null ? (
              <>
                {racesUntilTurn === 0 ? (
                  <div className="text-right">
                    <div className="text-sm font-heading font-black uppercase tracking-wider text-white animate-pulse">Up Now</div>
                    {nowUpMoto && nowUpMoto.familyGates.length > 0 && (
                      nowUpMoto.familyGates.length === 1 ? (
                        <div className="flex items-baseline gap-1 justify-end mt-0.5">
                          <span className={`text-xs ${isRaceDay ? "text-white/60" : "text-muted-foreground"}`}>Gate Pick</span>
                          <span className={`font-heading font-black text-2xl leading-none ${isRaceDay ? "text-white" : "text-foreground"}`}>{nowUpMoto.familyGates[0].gate}</span>
                        </div>
                      ) : (
                        <div className="mt-0.5 space-y-0.5">
                          {nowUpMoto.familyGates.map(fg => (
                            <div key={fg.gate} className="flex items-baseline gap-1 justify-end">
                              <span className={`text-xs ${isRaceDay ? "text-white/60" : "text-muted-foreground"}`}>{fg.riderName.split(" ")[0]} G</span>
                              <span className={`font-heading font-black text-xl leading-none ${isRaceDay ? "text-white" : "text-foreground"}`}>{fg.gate}</span>
                            </div>
                          ))}
                        </div>
                      )
                    )}
                  </div>
                ) : (
                  <>
                    <div className={`font-heading font-black text-3xl leading-none text-right ${isRaceDay ? "text-white" : "text-primary"}`}>{racesUntilTurn}</div>
                    <div className={`text-xs leading-tight text-right ${isRaceDay ? "text-white/60" : "text-muted-foreground"}`}>races away</div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className={`text-xs ${isRaceDay ? "text-white/60" : "text-muted-foreground"}`}>Your Races</div>
                <div className={`font-heading font-black text-3xl ${isRaceDay ? "text-white" : "text-primary"}`}>{myMotos.length}</div>
              </>
            )}
          </div>
          {collapsed
            ? <ChevronDown size={20} className={isRaceDay ? "text-white/70" : "text-muted-foreground"} />
            : <ChevronUp size={20} className={isRaceDay ? "text-white/70" : "text-muted-foreground"} />
          }
        </div>
      </button>

      {/* Motos — toggle bar + content */}
      {!collapsed && (
        <div className="bg-background">
          {/* View toggle bar */}
          {sortedMotos.length > 0 && (
            <div className="flex items-center justify-between px-3 pt-3 pb-1 gap-2">
              <span className="text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground">
                {showRunOrder ? "Run Order" : "My Schedule"}
              </span>
              <div className="flex items-center gap-0.5 border rounded-lg p-0.5 bg-muted/40">
                <button
                  onClick={() => setShowRunOrder(false)}
                  title="My schedule view"
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${
                    !showRunOrder
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <LayoutGrid size={12} />
                  <span>Schedule</span>
                </button>
                <button
                  onClick={() => setShowRunOrder(true)}
                  title="Full run order"
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${
                    showRunOrder
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <LayoutList size={12} />
                  <span>Run Order</span>
                </button>
              </div>
            </div>
          )}

          {/* Run Order list */}
          {showRunOrder ? (
            <div className="p-3">
              {runOrderMotos.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No races scheduled yet — check back closer to race day.
                </p>
              ) : (
                <div className="border rounded-xl overflow-hidden">
                  {runOrderMotos.map((moto, idx) => {
                    const isLive = moto.status === "in_progress";
                    const isDone = moto.status === "completed";
                    const isMine = moto.isAnyFamilyMemberInMoto;
                    const isNowUp = moto.motoId === nowUpMotoId || isLive;
                    const isUpNext = !isNowUp && moto.motoId === upNextMotoId;
                    const isFirstScheduled = !isLive && !isDone && runOrderMotos.slice(0, idx).every(m => m.status === "completed" || m.status === "in_progress") && moto.status === "scheduled";
                    const riderCount = moto.lineup.length;

                    return (
                      <div
                        key={moto.motoId}
                        className={`flex items-center gap-3 px-3 py-2.5 border-b last:border-b-0 transition-colors ${
                          isLive
                            ? "bg-green-500/8 border-l-[3px] border-l-green-500"
                            : isMine && !isDone
                            ? "bg-primary/5 border-l-[3px] border-l-primary"
                            : isDone
                            ? "opacity-50"
                            : isFirstScheduled
                            ? "bg-amber-500/5"
                            : ""
                        }`}
                      >
                        {/* Moto number circle */}
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center font-heading font-bold text-sm shrink-0 ${
                          isLive
                            ? "bg-green-500 text-white"
                            : isMine && !isDone
                            ? "bg-primary text-primary-foreground"
                            : isDone
                            ? "bg-muted text-muted-foreground"
                            : isFirstScheduled
                            ? "bg-amber-500/20 text-amber-700 border border-amber-400/40"
                            : "bg-muted/60 text-muted-foreground"
                        }`}>
                          {moto.motoNumber}
                        </div>

                        {/* Name + class */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-sm font-medium truncate ${isDone ? "text-muted-foreground" : isMine ? "text-foreground font-semibold" : "text-foreground"}`}>
                              {moto.name}
                            </span>
                            {isLive && (
                              <span className="relative flex h-1.5 w-1.5 shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                              </span>
                            )}
                            {isMine && !isDone && (
                              <span className="text-[10px] font-bold uppercase tracking-wider text-primary shrink-0">
                                {isNowUp ? "Now Up" : isUpNext ? "Up Next" : "Mine"}
                              </span>
                            )}
                            {isFirstScheduled && !isMine && (
                              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 shrink-0">Next</span>
                            )}
                          </div>
                          {moto.type === "practice" ? (
                            <span className="text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-500/10 text-sky-600 border border-sky-400/30 mr-1">Practice</span>
                              {moto.raceClass ?? "All Classes"}
                            </span>
                          ) : moto.raceClass ? (
                            <span className="text-xs text-muted-foreground">
                              {moto.raceClass} · {motoTypeLabel(moto.type)}
                              {riderCount > 0 && ` · ${riderCount} riders`}
                            </span>
                          ) : null}
                        </div>

                        {/* Status */}
                        <div className="shrink-0">
                          {isLive ? (
                            <span className="flex items-center gap-1 text-xs font-bold text-green-700 bg-green-500/15 border border-green-400/40 rounded-full px-2 py-0.5">
                              <Radio size={9} className="animate-pulse" /> Live
                            </span>
                          ) : isDone ? (
                            <span className="text-xs text-muted-foreground border border-border rounded-full px-2 py-0.5">Done</span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {sortedMotos.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No races scheduled yet — check back closer to race day.
                </p>
              )}
              {upcoming.map(moto => (
                <ScheduleMotoCard
                  key={moto.motoId}
                  moto={moto}
                  isNowUp={moto.motoId === nowUpMotoId}
                  isUpNext={moto.motoId === upNextMotoId}
                />
              ))}
              {finished.length > 0 && upcoming.length > 0 && (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-sm font-heading font-bold uppercase tracking-widest text-foreground shrink-0 px-1">
                    ✓ Finished Motos
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>
              )}
              {finished.map(moto => (
                <ScheduleMotoCard
                  key={moto.motoId}
                  moto={moto}
                  isUpNext={false}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RiderHistory() {
  const [, params] = useRoute("/rider/portal/:riderId");
  const riderId = parseInt(params?.riderId ?? "0", 10);
  const searchStr = useSearch();
  const tabParam = new URLSearchParams(searchStr).get("tab");
  const validTabs = ["today", "upcoming", "nearby", "races", "practice", "profile"] as const;
  const initialTab = validTabs.includes(tabParam as any) ? (tabParam as typeof validTabs[number]) : "today";
  const [activeTab, setActiveTab] = useState<typeof validTabs[number]>(initialTab);
  const [practiceMode, setPracticeMode] = useState<"event" | "open">("event");

  const { data, isLoading, error } = useQuery<RiderHistoryResponse>({
    queryKey: ["rider-history", riderId],
    queryFn: () => riderApi.history(riderId),
    enabled: !!riderId,
  } as any);

  const { data: practiceData, isLoading: practiceLoading } = useQuery<RiderPracticeResponse>({
    queryKey: ["rider-practice", riderId],
    queryFn: () => riderApi.practice(riderId),
    enabled: !!riderId,
    refetchInterval: 5_000,
  } as any);

  const { data: eventPracticeData, isLoading: eventPracticeLoading } = useQuery<RiderEventPracticeResponse>({
    queryKey: ["rider-event-practice", riderId],
    queryFn: () => riderApi.eventPractice(riderId),
    enabled: !!riderId,
    refetchInterval: 5_000,
  } as any);

  const { data: scheduleData, isLoading: scheduleLoading } = useQuery<RiderScheduleResponse>({
    queryKey: ["rider-schedule", riderId],
    queryFn: () => riderApi.schedule(riderId),
    enabled: !!riderId,
    refetchInterval: 15_000,
  } as any);

  const rider = data?.rider;
  const history = data?.history ?? [];
  const practiceSessions = practiceData?.sessions ?? [];

  // Split schedule events: today = race_day status OR date is today; upcoming = everything else
  const _todayStr = new Date().toLocaleDateString("en-CA");
  const todayEvents = (scheduleData?.events ?? []).filter(e =>
    e.status === "race_day" || (
      e.status !== "completed" && e.status !== "draft" &&
      !!e.eventDate && e.eventDate.substring(0, 10) === _todayStr
    )
  );
  const upcomingEvents = (scheduleData?.events ?? []).filter(e =>
    e.status !== "race_day" && e.status !== "completed" &&
    (!e.eventDate || e.eventDate.substring(0, 10) !== _todayStr)
  );

  // Auto-switch tab based on what the rider has scheduled
  const didAutoTab = useRef(false);
  useEffect(() => {
    if (!scheduleLoading && scheduleData && !didAutoTab.current) {
      didAutoTab.current = true;
      if (todayEvents.length > 0) {
        setActiveTab("today");
      } else if (upcomingEvents.length > 0) {
        setActiveTab("upcoming");
      } else {
        setActiveTab("nearby");
      }
    }
  }, [scheduleData, scheduleLoading]);

  const totalPoints = history.reduce((s, e) => s + e.totalPoints, 0);
  const eventsRaced = history.length;
  const allFinishes = history.flatMap((e) => e.motos).filter((m) => !m.dnf && !m.dns);
  const bestPosition = allFinishes.length > 0 ? Math.min(...allFinishes.map((m) => m.position)) : null;

  const totalPracticeLaps = practiceSessions.reduce((s, sess) => s + sess.lapCount, 0);
  const allPracticeTimes = practiceSessions.flatMap(s => s.laps.filter(l => l.lapTimeMs !== null && l.lapTimeMs > 0).map(l => l.lapTimeMs!));
  const overallBestPracticeMs = allPracticeTimes.length > 0 ? Math.min(...allPracticeTimes) : null;

  return (
    <RiderLayout showBack backTo="/rider/portal" backLabel="My Profiles">
      {isLoading ? (
        <div className="space-y-4">
          <div className="h-24 bg-muted animate-pulse rounded-xl" />
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-12 text-center">
            <AlertTriangle size={40} className="mx-auto text-destructive/40 mb-3" />
            <p className="text-muted-foreground">{(error as Error).message}</p>
          </CardContent>
        </Card>
      ) : rider ? (
        <div className="space-y-6">
          {/* Rider header */}
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <User size={24} className="text-primary" />
            </div>
            <div className="flex-1">
              <h1 className="font-heading font-bold text-3xl uppercase tracking-tight">
                {rider.firstName} {rider.lastName}
              </h1>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {rider.bibNumber && (
                  <span className="flex items-center gap-1 text-muted-foreground text-sm">
                    <Hash size={13} /> #{rider.bibNumber}
                  </span>
                )}
                {rider.dateOfBirth && (
                  <span className="flex items-center gap-1 text-muted-foreground text-sm">
                    <Calendar size={13} /> Born {rider.dateOfBirth}
                  </span>
                )}
              </div>
              <RfidEditor riderId={rider.id} currentRfid={rider.rfidNumber ?? null} />
            </div>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-3">
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                  <Calendar size={11} /> Events Raced
                </div>
                <div className="font-heading font-bold text-3xl">{eventsRaced}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                  <Trophy size={11} /> Best Finish
                </div>
                <div className="font-heading font-bold text-3xl">
                  {bestPosition ? `P${bestPosition}` : "—"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                  <Star size={11} /> Total Points
                </div>
                <div className="font-heading font-bold text-3xl text-primary">{totalPoints}</div>
              </CardContent>
            </Card>
          </div>

          {/* Tab switcher */}
          <div className="flex gap-1 border-b border-border overflow-x-auto">
            {/* Today tab */}
            {(() => {
              const hasLive = todayEvents.some(e => e.motos.some(m => m.status === "in_progress"));
              return (
                <button
                  onClick={() => setActiveTab("today")}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                    activeTab === "today"
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {hasLive ? <Radio size={14} className="animate-pulse text-green-500" /> : <Flag size={14} />}
                  Today
                  {todayEvents.length > 0 && (
                    <span className={`text-xs rounded-full px-1.5 py-0.5 font-mono ${
                      activeTab === "today"
                        ? hasLive ? "bg-green-500/10 text-green-600" : "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {todayEvents.length}
                    </span>
                  )}
                </button>
              );
            })()}
            {/* Upcoming tab */}
            <button
              onClick={() => setActiveTab("upcoming")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                activeTab === "upcoming"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Calendar size={14} />
              Upcoming
              {upcomingEvents.length > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 font-mono ${
                  activeTab === "upcoming" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {upcomingEvents.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("nearby")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                activeTab === "nearby"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <MapPin size={14} />
              Near Me
            </button>
            <button
              onClick={() => setActiveTab("races")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                activeTab === "races"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Trophy size={14} />
              Race History
              {eventsRaced > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 font-mono ${
                  activeTab === "races" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {eventsRaced}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("practice")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                activeTab === "practice"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Timer size={14} />
              Practice
              {practiceSessions.length > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 font-mono ${
                  activeTab === "practice" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {practiceSessions.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("profile")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                activeTab === "profile"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Settings size={14} />
              Profile
            </button>
          </div>

          {/* Near Me tab */}
          {activeTab === "nearby" && <NearMeTab />}

          {/* Today tab — race_day events only */}
          {activeTab === "today" && (
            <div>
              {scheduleLoading ? (
                <div className="space-y-4">
                  {[1, 2].map(i => <div key={i} className="h-40 bg-muted animate-pulse rounded-xl" />)}
                </div>
              ) : todayEvents.length === 0 ? (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Flag size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                    <h3 className="font-heading font-bold text-lg uppercase mb-1">No Events Today</h3>
                    <p className="text-muted-foreground text-sm">
                      You don't have any races scheduled for today.
                      {upcomingEvents.length > 0 && (
                        <> Check the <button onClick={() => setActiveTab("upcoming")} className="text-primary underline underline-offset-2">Upcoming</button> tab for future events.</>
                      )}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-6">
                  {todayEvents.map(event => (
                    <ScheduleEventSection key={event.eventId} event={event} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Upcoming tab — future registered events */}
          {activeTab === "upcoming" && (
            <div>
              {scheduleLoading ? (
                <div className="space-y-4">
                  {[1, 2].map(i => <div key={i} className="h-40 bg-muted animate-pulse rounded-xl" />)}
                </div>
              ) : upcomingEvents.length === 0 ? (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Calendar size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                    <h3 className="font-heading font-bold text-lg uppercase mb-1">No Upcoming Events</h3>
                    <p className="text-muted-foreground text-sm">
                      You're not registered for any future events yet.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-4">
                  {upcomingEvents.map(event => (
                    <div key={event.eventId} className="rounded-2xl border-2 overflow-hidden shadow-sm">
                      <div className="p-5 bg-muted">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <h3 className="font-heading font-black text-xl uppercase tracking-tight leading-none">
                              {event.eventName}
                            </h3>
                            <div className="flex items-center gap-3 mt-2 flex-wrap text-sm text-muted-foreground">
                              {event.eventDate && (
                                <span className="flex items-center gap-1">
                                  <Calendar size={13} />
                                  {new Date(event.eventDate).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                                </span>
                              )}
                              {(event.eventLocation || event.eventState) && (
                                <span className="flex items-center gap-1">
                                  <MapPin size={13} />
                                  {event.eventLocation ?? event.eventState}
                                  {event.eventLocation && event.eventState && `, ${event.eventState}`}
                                </span>
                              )}
                            </div>
                            {event.registrations.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-2.5">
                                {event.registrations.map(r => (
                                  <span key={r.riderId} className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2.5 py-0.5 font-semibold">
                                    {r.riderName}{r.raceClass ? ` · ${r.raceClass}` : ""}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            {event.eventDate && (() => {
                              const days = Math.ceil((new Date(event.eventDate).getTime() - Date.now()) / 86_400_000);
                              return days > 0 ? (
                                <>
                                  <div className="font-heading font-black text-3xl text-primary leading-none">{days}</div>
                                  <div className="text-xs text-muted-foreground">day{days !== 1 ? "s" : ""} away</div>
                                </>
                              ) : null;
                            })()}
                          </div>
                        </div>
                      </div>
                      {event.motos.length > 0 ? (
                        <div className="px-5 py-3 bg-background border-t text-sm text-muted-foreground">
                          {event.motos.length} race{event.motos.length !== 1 ? "s" : ""} scheduled — full lineup available on race day
                        </div>
                      ) : (
                        <div className="px-5 py-3 bg-background border-t text-sm text-muted-foreground">
                          Race schedule not posted yet — check back closer to race day
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Race History tab */}
          {activeTab === "races" && (
            <div>
              {history.length === 0 ? (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Flag size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-muted-foreground text-sm">No race results yet</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {history.map((event) => (
                    <EventCard key={event.eventId} event={event} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Practice tab */}
          {activeTab === "practice" && (
            <div>
              {/* Mode toggle */}
              <div className="flex gap-1 mb-4 p-1 bg-muted rounded-lg">
                <button
                  onClick={() => setPracticeMode("event")}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-heading font-bold uppercase tracking-wider transition-colors ${
                    practiceMode === "event"
                      ? "bg-background text-primary shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Flag size={12} />
                  Event Practice
                </button>
                <button
                  onClick={() => setPracticeMode("open")}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-heading font-bold uppercase tracking-wider transition-colors ${
                    practiceMode === "open"
                      ? "bg-background text-primary shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Radio size={12} />
                  Open Practice
                </button>
              </div>

              {/* Event Practice panel */}
              {practiceMode === "event" && (
                <EventPracticePanel
                  events={eventPracticeData?.events ?? []}
                  loading={eventPracticeLoading}
                  riderId={riderId}
                />
              )}

              {/* Open Practice panel */}
              {practiceMode === "open" && (
                practiceLoading ? (
                  <div className="space-y-3">
                    {[1, 2].map(i => (
                      <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" />
                    ))}
                  </div>
                ) : practiceSessions.length === 0 ? (
                  <Card>
                    <CardContent className="p-12 text-center">
                      <Timer size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                      <p className="text-muted-foreground text-sm">No open practice sessions recorded yet</p>
                      <p className="text-muted-foreground text-xs mt-1">
                        Lap times appear here when your RFID tag is captured during an open practice session.
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <Card>
                        <CardContent className="p-4 text-center">
                          <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                            <Timer size={11} /> Sessions
                          </div>
                          <div className="font-heading font-bold text-3xl">{practiceSessions.length}</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="p-4 text-center">
                          <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                            <Flag size={11} /> Total Laps
                          </div>
                          <div className="font-heading font-bold text-3xl">{totalPracticeLaps}</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="p-4 text-center">
                          <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                            <Clock size={11} /> Best Lap
                          </div>
                          <div className="font-heading font-bold text-xl text-primary font-mono">
                            {formatMs(overallBestPracticeMs)}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                    {[...practiceSessions].sort((a, b) => {
                      if (a.bestLapMs == null && b.bestLapMs == null) return 0;
                      if (a.bestLapMs == null) return 1;
                      if (b.bestLapMs == null) return -1;
                      return a.bestLapMs - b.bestLapMs;
                    }).map((session) => (
                      <PracticeSessionCard key={session.sessionId} session={session} />
                    ))}
                  </div>
                )
              )}
            </div>
          )}
          {/* Profile tab */}
          {activeTab === "profile" && (
            <ProfileEditor rider={rider} />
          )}
        </div>
      ) : null}
    </RiderLayout>
  );
}
