import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Activity, AlertCircle, Bookmark, CheckSquare, ChevronDown, ChevronLeft, ChevronUp, Cpu, Droplet, Loader2,
  MessageCircle, Minimize2, RotateCw, Send, Settings, SlidersHorizontal, Trash2, TrendingUp, Wrench, X, Zap,
  type LucideIcon,
} from "lucide-react";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { useActiveRiders } from "@/lib/rider-active";
import type { RiderProfile } from "@/lib/rider-api";
import { isNetworkError, NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { RockyAvatar } from "@/components/rider/web/RockyAvatar";

// Web version of Rocky, the rider app's AI mechanic and riding coach
// (rider-app/app/mechanic.tsx and context/RockyChatContext.tsx). Same API:
// /api/rider/mechanic-chat, /api/rider/mechanic-memory-update, /api/rider/memory
// and /api/rider/maintenance-check. The chat is kept for this browser tab
// (sessionStorage); Rocky's memory lives on the account, shared with the app.

interface ChatMessage { id: string; role: "user" | "assistant"; content: string }
interface FollowUpChip { label: string; question: string }

const MAX_PERSISTED_MESSAGES = 20;
const MAX_MEMORY_ENTRIES = 10;
const MAINT_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000;
const INTRO_SEEN_KEY = "rocky_intro_seen_web";

const chatKey = (pid: number | null) => `rocky_chat_history_${pid ?? "guest"}`;
const maintKey = (pid: number | null) => `rocky_maint_check_${pid ?? "guest"}`;

function storageGet(store: "local" | "session", key: string): string | null {
  try { return (store === "local" ? localStorage : sessionStorage).getItem(key); } catch { return null; }
}
function storageSet(store: "local" | "session", key: string, value: string | null) {
  try {
    const s = store === "local" ? localStorage : sessionStorage;
    if (value == null) s.removeItem(key); else s.setItem(key, value);
  } catch { /* private mode or full: not kept */ }
}

async function riderFetch(path: string, init?: RequestInit) {
  return fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
}

const parseMemory = (raw: string) => raw.split("\n").map(l => l.trim()).filter(Boolean);

// ─── Starter and follow-up questions (rider-app/components/RockyAvatar.tsx, utils/rockyFollowUps.ts) ──

const QUICK_QUESTIONS: { label: string; Icon: LucideIcon; question: string }[] = [
  { label: "Suspension setup", Icon: SlidersHorizontal, question: "How do I set up my suspension for a motocross track?" },
  { label: "Fix arm pump", Icon: Activity, question: "How do I fix arm pump while riding?" },
  { label: "Corner faster", Icon: RotateCw, question: "What's the best technique for cornering faster on a dirt bike?" },
  { label: "Jetting help", Icon: Droplet, question: "How do I know if my jetting is off and how do I fix it?" },
  { label: "Nail the start", Icon: Zap, question: "How do I get a better holeshot start?" },
  { label: "Pre-race checklist", Icon: CheckSquare, question: "What should be on my pre-race bike checklist?" },
];

const FOLLOW_UP_TOPICS: { keywords: string[]; chips: FollowUpChip[] }[] = [
  { keywords: ["suspension", "fork", "shock", "sag", "clicker", "rebound", "compression"], chips: [
    { label: "Check sag", question: "How do I check and set my sag correctly?" },
    { label: "Fork oil weight", question: "What fork oil weight should I run and how often should I change it?" },
    { label: "Bottoming out", question: "My suspension is bottoming out — how do I stiffen it up?" },
    { label: "Soft vs stiff", question: "Should I run softer or stiffer suspension for a hard-pack track?" },
  ] },
  { keywords: ["arm pump", "forearms", "grip", "arms", "pump"], chips: [
    { label: "Grip strength", question: "What exercises help reduce arm pump?" },
    { label: "Grip pressure", question: "How tight should I grip the handlebars?" },
    { label: "Bar setup", question: "Can bar height or position affect arm pump?" },
    { label: "Hydration", question: "Does hydration affect arm pump on race day?" },
  ] },
  { keywords: ["corner", "turn", "berm", "rut", "inside", "line"], chips: [
    { label: "Body position", question: "What body position should I use in berms?" },
    { label: "Braking point", question: "Where should I brake before a corner?" },
    { label: "Ruts", question: "How do I ride rutted corners faster?" },
    { label: "Exit drive", question: "How do I get better drive off corners?" },
  ] },
  { keywords: ["jetting", "carburetor", "carb", "fuel", "rich", "lean", "four-stroke", "two-stroke"], chips: [
    { label: "Rich vs lean", question: "How can I tell if I'm running rich or lean?" },
    { label: "Altitude changes", question: "How should I re-jet for high altitude racing?" },
    { label: "Main jet", question: "When should I go up or down a main jet size?" },
    { label: "Pilot jet", question: "What does the pilot jet affect and when should I change it?" },
  ] },
  { keywords: ["start", "holeshot", "gate", "launch", "clutch", "rev"], chips: [
    { label: "Clutch control", question: "How should I modulate the clutch at the start?" },
    { label: "Gate pick", question: "How do I pick the best gate position?" },
    { label: "Traction tip", question: "How do I prevent wheelies or wheelspin off the gate?" },
    { label: "Rev range", question: "What RPM range should I launch from?" },
  ] },
  { keywords: ["maintenance", "oil", "filter", "chain", "sprocket", "brake", "tire", "tyre", "wheel"], chips: [
    { label: "Oil intervals", question: "How often should I change the oil on my bike?" },
    { label: "Air filter", question: "How often should I clean my air filter?" },
    { label: "Chain tension", question: "How tight should my chain be and how do I adjust it?" },
    { label: "Brake pads", question: "How do I know when my brake pads need replacing?" },
  ] },
];
const FALLBACK_FOLLOW_UPS: FollowUpChip[] = [
  { label: "Suspension tune", question: "How do I tune my suspension for my riding style?" },
  { label: "Go faster", question: "What's the single biggest thing I can do to ride faster?" },
  { label: "Race prep", question: "What should I do the week before a race?" },
  { label: "Common mistakes", question: "What are the most common beginner mistakes to avoid?" },
];

/** Rocky's own suggestions when short enough to be chips, otherwise topic chips by keyword. */
function followUpChips(suggested: string[], lastUser: string): FollowUpChip[] {
  const ai = suggested.map(s => s.trim()).filter(s => s.length > 0 && s.length <= 40).map(q => ({ label: q, question: q }));
  if (ai.length > 0) return ai;
  const lower = lastUser.toLowerCase();
  return FOLLOW_UP_TOPICS.find(t => t.keywords.some(k => lower.includes(k)))?.chips ?? FALLBACK_FOLLOW_UPS;
}

// ─── Rider context ───────────────────────────────────────────────────────────

type BikeFields = { bikeYear?: string | null; bikeManufacturer?: string | null; bikeModel?: string | null };
type ProfileWithExtras = RiderProfile & BikeFields & { skillLevel?: string | null; raceTypes?: string[] | null };

/** The main garage bike, or the bike saved on the profile itself. */
function riderBike(p: ProfileWithExtras | null): BikeFields | null {
  if (!p) return null;
  const named = (b: BikeFields | null | undefined) => !!(b && (b.bikeManufacturer || b.bikeModel || b.bikeYear));
  const garage = (p.bikes ?? []).filter(named);
  const main = garage.find(b => b.isDefault) ?? garage[0];
  if (main) return main;
  return named(p) ? p : null;
}

function bikeLabel(b: BikeFields | null): string {
  return b ? [b.bikeYear, b.bikeManufacturer, b.bikeModel].filter(Boolean).join(" ") : "";
}

function buildGreeting(firstName: string | null, bike: string, experience: string | null): string {
  if (!firstName) return "Hey! I'm Rocky — your AI mechanic and riding coach. What can I help you with?";
  if (bike) {
    return `Hey ${firstName}! I'm Rocky — your AI mechanic and riding coach.\n\nI see you're on a ${bike}${experience ? ` at the ${experience} level` : ""}. Whether you've got a bike issue, want to go faster through a corner, or just need to dial in your setup — I'm here. What are we working on?`;
  }
  return `Hey ${firstName}! I'm Rocky — your AI mechanic and riding coach.\n\nI don't see your bike info yet — you can add it on your Profile, or just tell me what you're riding and we'll go from there. What can I help you with today?`;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const URL_SPLIT = /(https?:\/\/[^\s]+)/g;

function LinkedText({ text, onRed }: { text: string; onRed: boolean }) {
  return (
    <>
      {text.split(URL_SPLIT).map((part, i) => /^https?:\/\//.test(part)
        ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className={`underline break-all ${onRed ? "text-[#ffd0d6]" : "text-white decoration-[#A8A8A8]"}`}>{part}</a>
        : <Fragment key={i}>{part}</Fragment>)}
    </>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && <RockyAvatar size={30} online={false} />}
      <div className={`rounded-2xl px-3.5 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words ${isUser ? "bg-[#B30000] text-white max-w-[78%] rounded-br-md" : "bg-[#242424] border border-[#3A3A3A] text-[#FAFAFA] max-w-[82%] rounded-bl-md"}`}>
        <LinkedText text={msg.content} onRed={isUser} />
      </div>
    </div>
  );
}

function MemoryPanel({ memory, onClear }: { memory: string[]; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <div className="rounded-xl border border-[#3A3A3A] bg-[#242424]">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="w-full flex items-center justify-between gap-2 px-4 min-h-[44px]">
        <span className="flex items-center gap-1.5">
          <Cpu size={14} className="text-white" />
          <span className="text-[14px] font-bold text-[#FAFAFA]">Rocky's Memory</span>
          {memory.length > 0 && <span className="rounded-lg bg-[#B30000] px-1.5 text-[11px] font-bold text-white">{memory.length}</span>}
        </span>
        {open ? <ChevronUp size={15} className="text-[#A8A8A8]" /> : <ChevronDown size={15} className="text-[#A8A8A8]" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {memory.length === 0 ? (
            <p className="px-1 py-1.5 text-[13px] italic text-[#A8A8A8]">No memory yet — Rocky will learn from your conversations over time.</p>
          ) : (
            <ul className="max-h-[180px] overflow-y-auto rounded-lg border border-[#3A3A3A]">
              {memory.map((entry, i) => (
                <li key={i} className="flex items-start gap-2 bg-[#2E2E2E] px-2.5 py-2 border-b border-[#3A3A3A] last:border-b-0">
                  <Bookmark size={12} className="shrink-0 mt-0.5 text-[#A8A8A8]" />
                  <span className="text-[13px] leading-snug text-[#FAFAFA]">{entry}</span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => { if (confirming) { onClear(); setConfirming(false); setOpen(false); } else setConfirming(true); }}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 min-h-[36px] text-[13px] font-medium ${confirming ? "border-[#f87171] bg-[#f87171]/15 text-[#fca5a5]" : "border-[#3A3A3A] bg-[#2E2E2E] text-[#A8A8A8] hover:text-white"}`}
          >
            <Trash2 size={13} />{confirming ? "Click again to confirm" : "Clear memory"}
          </button>
        </div>
      )}
    </div>
  );
}

const INTRO_POINTS: [LucideIcon, string][] = [
  [Wrench, "Bike problems, setup and maintenance: just describe it."],
  [TrendingUp, "Riding tips to get faster: starts, corners, ruts, whoops."],
  [Cpu, "Remembers your bike and riding, so advice fits you."],
  [MessageCircle, "Minimize me and I'll wait in the corner of every screen."],
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RiderMechanic() {
  const [, navigate] = useLocation();
  const { activeProfiles } = useActiveRiders();
  const profile = (activeProfiles[0] ?? null) as ProfileWithExtras | null;
  const pid = profile?.id ?? null;

  const bike = riderBike(profile);
  const bikeStr = bikeLabel(bike);
  const experience = profile?.skillLevel && profile.skillLevel !== "not specified" ? profile.skillLevel : null;
  const greeting = buildGreeting(profile?.firstName ?? null, bikeStr, experience);

  const riderContext = useMemo(() => profile ? {
    riderId: profile.id,
    name: `${profile.firstName} ${profile.lastName}`,
    bikeMake: bike?.bikeManufacturer ?? "",
    bikeModel: bike?.bikeModel ?? "",
    bikeYear: bike?.bikeYear ?? "",
    rideExperience: experience ?? "not specified",
    eventsRaced: profile.eventsRaced,
    bestPosition: profile.bestPosition,
    recentClass: null,
    raceTypes: profile.raceTypes ?? [],
  } : null, [profile, bike, experience]);

  const [messages, setMessages] = useState<ChatMessage[]>([{ id: "init", role: "assistant", content: greeting }]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [memory, setMemory] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showIntro, setShowIntro] = useState(() => storageGet("local", INTRO_SEEN_KEY) !== "1");

  const messagesRef = useRef(messages);
  const memoryRef = useRef("");
  const contextRef = useRef(riderContext);
  contextRef.current = riderContext;
  // The profile whose chat is loaded; nothing is saved while another one's is loading.
  const loadedPid = useRef<number | null | "none">("none");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const setMsgs = (next: ChatMessage[]) => { messagesRef.current = next; setMessages(next); };

  // Load this rider's chat (this tab), memory and any maintenance reminder.
  useEffect(() => {
    let cancelled = false;
    loadedPid.current = "none";
    const memoryP = pid != null
      ? riderFetch("/api/rider/memory").then(r => (r.ok ? r.json() : null)).then(d => (typeof d?.memory === "string" ? d.memory as string : "")).catch(() => "")
      : Promise.resolve("");
    const maintP = pid != null
      ? riderFetch("/api/rider/maintenance-check").then(r => (r.ok ? r.json() : null)).catch(() => null)
      : Promise.resolve(null);
    void Promise.all([memoryP, maintP]).then(([mem, maint]) => {
      if (cancelled) return;
      memoryRef.current = mem;
      setMemory(parseMemory(mem));

      let base: ChatMessage[] = [{ id: "init", role: "assistant", content: greeting }];
      try {
        const saved = JSON.parse(storageGet("session", chatKey(pid)) ?? "null");
        if (Array.isArray(saved) && saved.length > 0 && saved.every(m => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))) base = saved;
      } catch { /* start fresh */ }

      const last = Number(storageGet("local", maintKey(pid)) ?? 0);
      if (maint?.hasItems && typeof maint.message === "string" && maint.message && Date.now() - last > MAINT_CHECK_INTERVAL_MS) {
        base = [...base, { id: `maint-check-${Date.now()}`, role: "assistant", content: maint.message }];
        storageSet("local", maintKey(pid), String(Date.now()));
      }
      loadedPid.current = pid;
      setMsgs(base);
    });
    return () => { cancelled = true; };
    // The greeting only matters for a fresh chat; reloading on every profile field change would drop the chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // Keep the chat for this tab.
  useEffect(() => {
    if (loadedPid.current !== pid) return;
    storageSet("session", chatKey(pid), JSON.stringify(messages.slice(-MAX_PERSISTED_MESSAGES)));
  }, [messages, pid]);

  // Follow the conversation as it grows (not on first load).
  const prevCount = useRef(0);
  useEffect(() => {
    const grew = messages.length > prevCount.current && prevCount.current > 0;
    prevCount.current = messages.length;
    if (grew || isTyping) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isTyping]);

  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const appendMemory = useCallback((entry: string, forPid: number | null) => {
    const lines = [...parseMemory(memoryRef.current), entry].slice(-MAX_MEMORY_ENTRIES);
    const blob = lines.join("\n");
    memoryRef.current = blob;
    setMemory(lines);
    if (forPid != null) void riderFetch("/api/rider/memory", { method: "PATCH", body: JSON.stringify({ memory: blob }) }).catch(() => {});
  }, []);

  const clearMemory = useCallback(() => {
    memoryRef.current = "";
    setMemory([]);
    if (pid != null) void riderFetch("/api/rider/memory", { method: "PATCH", body: JSON.stringify({ memory: "" }) }).catch(() => {});
  }, [pid]);

  const clearChat = () => {
    storageSet("session", chatKey(pid), null);
    setMsgs([{ id: "init", role: "assistant", content: greeting }]);
    setSuggested([]);
    setError(null);
  };

  const send = useCallback(async (text?: string) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed || isTyping) return;
    if (text == null) setInput("");
    setError(null);
    setSuggested([]);
    setShowIntro(false);

    const withUser = [...messagesRef.current, { id: `${Date.now()}`, role: "user" as const, content: trimmed }];
    setMsgs(withUser);
    setIsTyping(true);
    const sentFor = pid;
    try {
      const res = await riderFetch("/api/rider/mechanic-chat", {
        method: "POST",
        body: JSON.stringify({
          messages: withUser.map(m => ({ role: m.role, content: m.content })),
          riderContext: contextRef.current,
          riderMemory: memoryRef.current || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? (res.status === 401 ? "You're signed out. Sign in again, then try once more." : "Rocky didn't respond. Try again in a moment."));
      }
      const data = await res.json() as { reply?: unknown; suggestedFollowUps?: unknown };
      const reply = typeof data.reply === "string" && data.reply.trim() ? data.reply : "Sorry, I lost my train of thought there. Can you ask that again?";
      setSuggested(Array.isArray(data.suggestedFollowUps) ? data.suggestedFollowUps.filter((s): s is string => typeof s === "string").slice(0, 3) : []);
      setMsgs([...messagesRef.current, { id: `${Date.now() + 1}`, role: "assistant", content: reply }]);

      // Summarise this exchange into one memory line, in the background.
      void riderFetch("/api/rider/mechanic-memory-update", {
        method: "POST",
        body: JSON.stringify({ lastUserMessage: trimmed, lastAssistantReply: reply, riderContext: contextRef.current }),
      })
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (typeof d?.memoryEntry === "string" && d.memoryEntry) appendMemory(d.memoryEntry, sentFor); })
        .catch(() => {});
    } catch (e) {
      setError(isNetworkError(e) ? NETWORK_ERROR_MESSAGE : (e as Error)?.message || "Something went wrong. Try again.");
    } finally {
      setIsTyping(false);
    }
  }, [input, isTyping, pid, appendMemory]);

  const dismissIntro = () => {
    setShowIntro(false);
    storageSet("local", INTRO_SEEN_KEY, "1");
  };
  const minimize = () => {
    storageSet("local", INTRO_SEEN_KEY, "1");
    if (window.history.length > 1) window.history.back();
    else navigate("/rider/home");
  };

  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  const chips = !isTyping && lastUser && lastAssistant ? followUpChips(suggested, lastUser.content) : [];

  return (
    <RiderLayout hideRocky>
      <div className="mx-auto max-w-[760px] pt-4 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center gap-3 rounded-2xl border border-[#3A3A3A] bg-[#242424] px-3 py-3">
          <button type="button" onClick={minimize} aria-label="Minimize Rocky" className="shrink-0 w-10 h-10 rounded-full bg-[#2E2E2E] flex items-center justify-center text-[#FAFAFA] hover:bg-[#3A3A3A]">
            <ChevronLeft size={20} />
          </button>
          <RockyAvatar size={42} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h1 className="font-heading font-extrabold italic uppercase text-[22px] leading-none tracking-[0.5px] text-[#FAFAFA]">Rocky</h1>
              <span className="rounded-md bg-[#B30000] px-1.5 py-0.5 text-[10px] font-bold tracking-[0.8px] text-white">AI</span>
            </div>
            <div className="text-[13px] font-semibold text-[#22c55e] mt-1" aria-live="polite">{isTyping ? "Rocky is typing…" : "Online · Mechanic & riding coach"}</div>
          </div>
          <button
            type="button"
            onClick={() => { if (confirmClear) { clearChat(); setConfirmClear(false); } else setConfirmClear(true); }}
            aria-label={confirmClear ? "Click again to clear the chat" : "Clear chat"}
            title="Clear chat"
            className={`shrink-0 h-10 rounded-full px-3 flex items-center gap-1.5 text-[13px] font-bold ${confirmClear ? "bg-[#f87171]/15 text-[#fca5a5]" : "bg-[#2E2E2E] text-[#A8A8A8] hover:text-white"}`}
          >
            <Trash2 size={15} />{confirmClear && "Clear chat"}
          </button>
        </div>

        {bikeStr && (
          <div className="flex items-center gap-1.5 rounded-xl border border-[#3A3A3A] bg-[#2E2E2E] px-3 py-2 text-[13px] font-medium text-[#FAFAFA]">
            <Settings size={12} className="text-[#A8A8A8]" />
            {bikeStr}
            {experience && <><span className="w-1 h-1 rounded-full bg-[#A8A8A8]" /><span className="capitalize">{experience}</span></>}
          </div>
        )}

        {showIntro && (
          <section aria-label="Meet Rocky" className="rounded-[20px] border-[1.5px] border-[#B30000]/70 bg-[#242424] p-5 space-y-3 shadow-[0_4px_24px_rgba(179,0,0,0.3)]">
            <div className="flex items-center gap-3">
              <RockyAvatar size={52} />
              <div>
                <div className="text-[12px] font-heading font-bold uppercase tracking-[1.2px] text-[#A8A8A8]">Your new crew chief</div>
                <h2 className="font-heading font-extrabold italic uppercase text-[24px] leading-tight text-[#FAFAFA]">Meet Rocky</h2>
              </div>
            </div>
            <ul className="space-y-2.5">
              {INTRO_POINTS.map(([Icon, text]) => (
                <li key={text} className="flex items-center gap-2.5">
                  <span className="w-7 h-7 shrink-0 rounded-full bg-[#B30000]/25 flex items-center justify-center"><Icon size={14} className="text-white" /></span>
                  <span className="text-[15px] font-medium text-[#FAFAFA] leading-snug">{text}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button type="button" onClick={minimize} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full bg-[#B30000] min-h-[46px] font-heading font-bold uppercase tracking-[0.8px] text-[15px] text-white hover:bg-[#990000]">
                <Minimize2 size={15} />Minimize Rocky
              </button>
              <button type="button" onClick={() => { dismissIntro(); inputRef.current?.focus(); }} className="flex-1 rounded-full border border-[#3A3A3A] bg-[#2E2E2E] min-h-[46px] font-heading font-bold uppercase tracking-[0.8px] text-[15px] text-[#FAFAFA] hover:border-[#A8A8A8]">
                Ask a question
              </button>
            </div>
          </section>
        )}

        <p className="text-center text-[12px] leading-snug text-[#A8A8A8] px-2">
          Rocky's advice is for information only. Check your owner's manual, and use a qualified mechanic for safety-critical repairs.
        </p>

        <MemoryPanel memory={memory} onClear={clearMemory} />

        {/* Messages */}
        <div className="flex flex-col gap-3 pt-2" role="log" aria-label="Chat with Rocky" aria-live="polite">
          {messages.map(m => <Bubble key={m.id} msg={m} />)}
          {isTyping && (
            <div className="flex items-end gap-2">
              <RockyAvatar size={30} online={false} />
              <div className="rounded-2xl rounded-bl-md bg-[#242424] border border-[#3A3A3A] px-4 py-3">
                <Loader2 size={16} className="animate-spin text-[#A8A8A8]" aria-label="Rocky is typing" />
              </div>
            </div>
          )}
          {!isTyping && !lastUser && (
            <div className="pt-1">
              <div className="font-heading font-bold uppercase tracking-[1px] text-[14px] text-[#A8A8A8] mb-2 ml-0.5">Try asking</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {QUICK_QUESTIONS.map(({ label, Icon, question }) => (
                  <button key={label} type="button" onClick={() => void send(question)} title={question}
                    className="flex items-center gap-2 rounded-xl border border-[#3A3A3A] bg-[#242424] px-2.5 py-2.5 text-left hover:bg-[#2A2A2A] hover:border-[#A8A8A8]">
                    <span className="w-7 h-7 shrink-0 rounded-full bg-[#B30000]/25 flex items-center justify-center"><Icon size={14} className="text-white" /></span>
                    <span className="truncate text-[14px] font-semibold text-[#FAFAFA]">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Error, follow-ups and the input stay pinned above the bottom tabs. */}
        <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] md:bottom-0 z-20 -mx-4 px-4 pt-2 pb-3 bg-[#161616]/95 backdrop-blur border-t border-[#2E2E2E] space-y-2">
          {error && (
            <div role="alert" className="flex items-center gap-2 rounded-lg bg-[#f87171]/15 px-3 py-2.5">
              <AlertCircle size={15} className="shrink-0 text-[#fca5a5]" />
              <span className="flex-1 text-[13px] text-[#fca5a5]">{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="text-[#fca5a5] hover:text-white"><X size={15} /></button>
            </div>
          )}
          {chips.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              {chips.map(c => (
                <button key={c.question} type="button" onClick={() => void send(c.question)} title={c.question}
                  className="shrink-0 rounded-full border border-[#B30000]/60 bg-[#B30000]/15 px-3 py-1.5 text-[13px] font-semibold text-[#FAFAFA] hover:bg-[#B30000]/30">
                  {c.label}
                </button>
              ))}
            </div>
          )}
          <form className="flex items-end gap-2.5" onSubmit={e => { e.preventDefault(); void send(); }}>
            <label htmlFor="rocky-input" className="sr-only">Message Rocky</label>
            <textarea
              id="rocky-input"
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
              placeholder="Ask Rocky anything about your bike or riding…"
              rows={1}
              maxLength={1000}
              disabled={isTyping}
              className="flex-1 resize-none max-h-[120px] min-h-[46px] rounded-[23px] border border-[#3A3A3A] bg-[#2E2E2E] px-4 py-[11px] leading-snug text-[#FAFAFA] placeholder:text-[#A8A8A8] outline-none focus:border-[#A8A8A8] disabled:opacity-60 [field-sizing:content]"
            />
            <button type="submit" aria-label="Send" disabled={!input.trim() || isTyping}
              className="shrink-0 w-[46px] h-[46px] rounded-full bg-[#B30000] text-white flex items-center justify-center hover:bg-[#990000] disabled:opacity-45 disabled:cursor-not-allowed">
              <Send size={18} />
            </button>
          </form>
        </div>
      </div>
    </RiderLayout>
  );
}
