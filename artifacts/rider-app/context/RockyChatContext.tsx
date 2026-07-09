import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useRiderAuth } from "@/context/AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface RockyChatContextType {
  messages: ChatMessage[];
  isTyping: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  inputText: string;
  setInputText: (t: string) => void;
  sendMessage: (text?: string) => Promise<void>;
  clearChat: () => Promise<void>;
  memory: string[];
  clearMemory: () => Promise<void>;
  suggestedFollowUps: string[];
}

// ─── Context ──────────────────────────────────────────────────────────────────

const RockyChatContext = createContext<RockyChatContextType | null>(null);

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_PERSISTED_MESSAGES = 20;
const MAX_MEMORY_ENTRIES = 10;
const MAINT_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

function storageKey(profileId: number | null): string {
  return profileId != null
    ? `rocky_chat_history_${profileId}`
    : "rocky_chat_history_guest";
}

function memoryKey(profileId: number | null): string {
  return profileId != null
    ? `rocky_memory_${profileId}`
    : "rocky_memory_guest";
}

function maintCheckKey(profileId: number | null): string {
  return profileId != null ? `rocky_maint_check_${profileId}` : "rocky_maint_check_guest";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseMemoryLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildGreeting(
  firstName: string,
  bikeStr: string,
  experience: string | undefined,
): string {
  const hasBike = bikeStr.trim().length > 0;
  const expStr = experience && experience !== "not specified" ? experience : null;
  if (hasBike) {
    return `Hey ${firstName}! I'm Rocky — your AI mechanic and riding coach.\n\nI see you're on a ${bikeStr}${expStr ? ` at the ${expStr} level` : ""}. Whether you've got a bike issue, want to go faster through a corner, or just need to dial in your setup — I'm here. What are we working on?`;
  }
  return `Hey ${firstName}! I'm Rocky — your AI mechanic and riding coach.\n\nI don't see your bike info yet — you can add it in the Profile tab, or just tell me what you're riding and we'll go from there. What can I help you with today?`;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function RockyChatProvider({ children }: { children: React.ReactNode }) {
  const { activeProfiles, bikeInfoMap, riderFetch } = useRiderAuth();
  const primaryProfile = activeProfiles[0] ?? null;

  const _defaultBike = primaryProfile?.bikes?.find(b => b.isDefault) ?? primaryProfile?.bikes?.[0];
  const bikeStr = _defaultBike
    ? [_defaultBike.bikeYear, _defaultBike.bikeManufacturer, _defaultBike.bikeModel].filter(Boolean).join(" ")
    : "";
  const storedInfo = primaryProfile ? (bikeInfoMap[primaryProfile.id] ?? {}) : {};

  const greetingText = primaryProfile
    ? buildGreeting(primaryProfile.firstName, bikeStr, storedInfo.rideExperience)
    : "Hey! I'm Rocky — your AI mechanic and riding coach. What can I help you with?";

  const initMsg: ChatMessage = { id: "init", role: "assistant", content: greetingText };

  const [messages, setMessages] = useState<ChatMessage[]>([initMsg]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [memory, setMemory] = useState<string[]>([]);
  const [suggestedFollowUps, setSuggestedFollowUps] = useState<string[]>([]);

  // Keep a ref so the async sendMessage closure always sees latest messages
  const messagesRef = useRef<ChatMessage[]>([initMsg]);

  // Rider memory blob — persists across sessions, injected into system prompt
  const memoryRef = useRef<string>("");

  // Keep riderContext in a ref so sendMessage doesn't need it as a dep
  const riderContextRef = useRef<object | null>(null);
  riderContextRef.current = primaryProfile
    ? {
        riderId: primaryProfile.id,
        name: `${primaryProfile.firstName} ${primaryProfile.lastName}`,
        bikeMake: (primaryProfile.bikes?.find(b => b.isDefault) ?? primaryProfile.bikes?.[0])?.bikeManufacturer ?? "",
        bikeModel: (primaryProfile.bikes?.find(b => b.isDefault) ?? primaryProfile.bikes?.[0])?.bikeModel ?? "",
        bikeYear: (primaryProfile.bikes?.find(b => b.isDefault) ?? primaryProfile.bikes?.[0])?.bikeYear ?? "",
        rideExperience: storedInfo.rideExperience ?? "not specified",
        eventsRaced: primaryProfile.eventsRaced,
        bestPosition: primaryProfile.bestPosition,
        recentClass: null,
        raceTypes: primaryProfile.raceTypes ?? [],
      }
    : null;

  // ── Persist messages to AsyncStorage ─────────────────────────────────────

  const saveMessages = useCallback(
    async (msgs: ChatMessage[], profileId: number | null) => {
      try {
        const toSave = msgs.slice(-MAX_PERSISTED_MESSAGES);
        await AsyncStorage.setItem(storageKey(profileId), JSON.stringify(toSave));
      } catch {
        // non-fatal; silently ignore storage errors
      }
    },
    [],
  );

  // ── Initialize messages for a profile ────────────────────────────────────

  const initializedProfileId = useRef<number | null | "none">("none");

  useEffect(() => {
    const pid = primaryProfile?.id ?? null;

    // Guard: only run when the profile ID actually changes
    if (initializedProfileId.current === pid) return;
    initializedProfileId.current = pid;

    const key = storageKey(pid);
    const mKey = memoryKey(pid);
    const mCheckKey = maintCheckKey(pid);
    let cancelled = false;

    // Fetch server memory + maintenance check in parallel with local storage reads
    const serverMemoryPromise = pid != null
      ? riderFetch("/api/rider/memory")
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => (typeof data?.memory === "string" ? data.memory : null))
          .catch(() => null)
      : Promise.resolve(null);

    const maintenanceCheckPromise = pid != null
      ? riderFetch("/api/rider/maintenance-check")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null);

    Promise.all([
      AsyncStorage.getItem(key),
      AsyncStorage.getItem(mKey),
      serverMemoryPromise,
      maintenanceCheckPromise,
      AsyncStorage.getItem(mCheckKey),
    ]).then(
      ([raw, rawMemory, serverMemory, maintenanceCheck, lastCheckRaw]) => {
        if (cancelled) return;

        // Server wins on conflict: use server memory if available, otherwise fall back to local
        const resolvedMemory = serverMemory ?? rawMemory ?? "";
        memoryRef.current = resolvedMemory;
        setMemory(parseMemoryLines(resolvedMemory));

        if (serverMemory != null && serverMemory !== (rawMemory ?? "")) {
          AsyncStorage.setItem(memoryKey(pid), resolvedMemory).catch(() => {});
        }

        // Determine whether we should show a maintenance reminder
        const lastCheckTime = lastCheckRaw ? parseInt(lastCheckRaw, 10) : 0;
        const shouldShowMaintCheck =
          maintenanceCheck?.hasItems &&
          maintenanceCheck?.message &&
          Date.now() - lastCheckTime > MAINT_CHECK_INTERVAL_MS;

        let baseMessages: ChatMessage[];

        if (raw) {
          try {
            const saved: ChatMessage[] = JSON.parse(raw);
            if (Array.isArray(saved) && saved.length > 0) {
              baseMessages = saved;
            } else {
              baseMessages = [{ id: "init", role: "assistant", content: greetingText }];
            }
          } catch {
            baseMessages = [{ id: "init", role: "assistant", content: greetingText }];
          }
        } else {
          baseMessages = [{ id: "init", role: "assistant", content: greetingText }];
        }

        // Inject maintenance reminder as a Rocky message
        if (shouldShowMaintCheck) {
          baseMessages = [
            ...baseMessages,
            {
              id: `maint-check-${Date.now()}`,
              role: "assistant",
              content: maintenanceCheck.message,
            },
          ];
          // Record timestamp so we don't spam it
          AsyncStorage.setItem(mCheckKey, Date.now().toString()).catch(() => {});
        }

        messagesRef.current = baseMessages;
        setMessages(baseMessages);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [primaryProfile?.id, greetingText, riderFetch]);

  // ── Persist whenever messages change ─────────────────────────────────────

  useEffect(() => {
    const pid = primaryProfile?.id ?? null;
    void saveMessages(messages, pid);
  }, [messages, primaryProfile?.id, saveMessages]);

  // ── Clear chat ────────────────────────────────────────────────────────────

  const clearChat = useCallback(async () => {
    const pid = primaryProfile?.id ?? null;
    try {
      await AsyncStorage.removeItem(storageKey(pid));
    } catch {
      // non-fatal
    }
    const greeting: ChatMessage[] = [
      { id: "init", role: "assistant", content: greetingText },
    ];
    messagesRef.current = greeting;
    setMessages(greeting);
    setSuggestedFollowUps([]);
  }, [primaryProfile?.id, greetingText]);

  // ── Clear memory only ─────────────────────────────────────────────────────

  const clearMemory = useCallback(async () => {
    const pid = primaryProfile?.id ?? null;
    memoryRef.current = "";
    setMemory([]);
    try {
      await AsyncStorage.removeItem(memoryKey(pid));
    } catch {
      // non-fatal
    }
  }, [primaryProfile?.id]);

  // ── Append a new entry to the memory blob and persist it ─────────────────

  const appendMemoryEntry = useCallback(
    async (entry: string, profileId: number | null) => {
      const existing = memoryRef.current;
      const lines = existing
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      lines.push(entry);
      const trimmed = lines.slice(-MAX_MEMORY_ENTRIES).join("\n");
      memoryRef.current = trimmed;
      setMemory(parseMemoryLines(trimmed));
      try {
        await AsyncStorage.setItem(memoryKey(profileId), trimmed);
      } catch {
        // non-fatal
      }
      if (profileId != null) {
        riderFetch("/api/rider/memory", {
          method: "PATCH",
          body: JSON.stringify({ memory: trimmed }),
        }).catch(() => {});
      }
    },
    [riderFetch],
  );

  // ── Send message ──────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text?: string) => {
      const trimmed = (text ?? inputText).trim();
      if (!trimmed || isTyping) return;

      if (!text) setInputText("");
      setError(null);
      setSuggestedFollowUps([]);

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: "user",
        content: trimmed,
      };

      const updatedMessages = [...messagesRef.current, userMsg];
      messagesRef.current = updatedMessages;
      setMessages(updatedMessages);
      setIsTyping(true);

      try {
        const apiMessages = updatedMessages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const res = await riderFetch("/api/rider/mechanic-chat", {
          method: "POST",
          body: JSON.stringify({
            messages: apiMessages,
            riderContext: riderContextRef.current,
            riderMemory: memoryRef.current || undefined,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as any).error ?? `Server error ${res.status}`);
        }

        const data = await res.json();
        const reply: string = data.reply;
        const followUps: string[] = Array.isArray(data.suggestedFollowUps)
          ? (data.suggestedFollowUps as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3)
          : [];
        setSuggestedFollowUps(followUps);

        const assistantMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: reply,
        };
        const withReply = [...messagesRef.current, assistantMsg];
        messagesRef.current = withReply;
        setMessages(withReply);

        // Fire-and-forget: summarise this exchange into a memory entry
        const pid = primaryProfile?.id ?? null;
        riderFetch("/api/rider/mechanic-memory-update", {
          method: "POST",
          body: JSON.stringify({
            lastUserMessage: trimmed,
            lastAssistantReply: reply,
            riderContext: riderContextRef.current,
          }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.memoryEntry) {
              void appendMemoryEntry(data.memoryEntry, pid);
            }
          })
          .catch(() => {});
      } catch (e: any) {
        setError(e.message ?? "Something went wrong. Try again.");
      } finally {
        setIsTyping(false);
      }
    },
    [isTyping, inputText, riderFetch, primaryProfile?.id, appendMemoryEntry],
  );

  return (
    <RockyChatContext.Provider
      value={{
        messages,
        isTyping,
        error,
        setError,
        inputText,
        setInputText,
        sendMessage,
        clearChat,
        memory,
        clearMemory,
        suggestedFollowUps,
      }}
    >
      {children}
    </RockyChatContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRockyChat(): RockyChatContextType {
  const ctx = useContext(RockyChatContext);
  if (!ctx) throw new Error("useRockyChat must be used inside RockyChatProvider");
  return ctx;
}
