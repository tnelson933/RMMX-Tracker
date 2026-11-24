import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendAnnouncementTask,
  isAnnouncementStale,
  isCurrentAnnouncementGeneration,
  queueAnnouncement,
  shouldAcceptAnnouncement,
  shouldQueueAnnouncementAudio,
  type QueuedAnnouncement,
  type SharedAnnouncement,
} from "@/lib/sharedAnnouncer";

/**
 * The shared race announcer for one moto, as Watch Live plays it (same
 * stream, same lib/sharedAnnouncer.ts rules), for pages that only listen.
 *
 * Listens only while `on`: the stream opens when the viewer turns it on (a tap,
 * so the browser lets audio play). The server's sequence is durable and
 * monotonic for the moto's lifetime; the last accepted number is kept per moto
 * across off/on so a reconnect never replays or repeats a call.
 */
export function useSharedAnnouncer(motoId: number | null, on: boolean) {
  const [label, setLabel] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(false);

  const onRef = useRef(on);
  const queueRef = useRef<QueuedAnnouncement[]>([]);
  const playingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const fetchChainRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const lastSequenceRef = useRef<{ motoId: number | null; sequence: number }>({ motoId: null, sequence: 0 });

  const stopAudio = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.src = "";
      currentAudioRef.current = null;
    }
    playingRef.current = false;
    for (const item of queueRef.current) URL.revokeObjectURL(item.url);
    queueRef.current = [];
  }, []);

  useEffect(() => {
    onRef.current = on;
    if (!on) { stopAudio(); setLabel(null); }
  }, [on, stopAudio]);

  const drain = useCallback(() => {
    if (playingRef.current || queueRef.current.length === 0) return;
    if (!onRef.current) { queueRef.current = []; return; }
    const { url, announcement } = queueRef.current.shift()!;
    if (isAnnouncementStale(announcement)) {
      URL.revokeObjectURL(url);
      drain();
      return;
    }
    playingRef.current = true;
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    const done = () => {
      URL.revokeObjectURL(url);
      playingRef.current = false;
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      drain();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(() => { playingRef.current = false; drain(); });
  }, []);

  const receive = useCallback((announcement: SharedAnnouncement | null | undefined, generation: number) => {
    if (!shouldAcceptAnnouncement(lastSequenceRef.current.sequence, announcement) || !announcement) return;
    lastSequenceRef.current.sequence = announcement.sequence;
    fetchChainRef.current = appendAnnouncementTask(fetchChainRef.current, async () => {
      if (!isCurrentAnnouncementGeneration(generationRef.current, generation)) return;
      if (!shouldQueueAnnouncementAudio(onRef.current)) return;
      try {
        setLabel(announcement.label);
        setError(false);
        let blob: Blob | null = null;
        for (let attempt = 0; attempt < 3 && !blob; attempt++) {
          if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
          const res = await fetch(announcement.audioUrl).catch(() => null);
          if (res?.ok) blob = await res.blob();
        }
        if (!isCurrentAnnouncementGeneration(generationRef.current, generation)) return;
        if (!blob) { setError(true); setLabel(null); return; }
        if (!onRef.current) return;
        const url = URL.createObjectURL(blob);
        const { queue, dropped } = queueAnnouncement(queueRef.current, { url, announcement });
        for (const item of dropped) URL.revokeObjectURL(item.url);
        queueRef.current = queue;
        drain();
        setTimeout(() => setLabel(current => (current === announcement.label ? null : current)), 6_000);
      } catch { setLabel(null); }
    });
  }, [drain]);

  useEffect(() => {
    const generation = ++generationRef.current;
    fetchChainRef.current = Promise.resolve();
    stopAudio();
    setLabel(null);
    setConnected(false);
    setError(false);
    if (lastSequenceRef.current.motoId !== motoId) lastSequenceRef.current = { motoId, sequence: 0 };
    if (!on || !motoId) return;

    const source = new EventSource(`/api/timing/announcer-live/${motoId}`);
    source.onopen = () => { if (generationRef.current === generation) setConnected(true); };
    source.onerror = () => { if (generationRef.current === generation) setConnected(false); };
    source.onmessage = evt => {
      try {
        receive(JSON.parse(evt.data).announcement, generation);
      } catch { /* ignore an unreadable message */ }
    };
    return () => {
      if (generationRef.current === generation) generationRef.current++;
      source.close();
      stopAudio();
    };
  }, [motoId, on, receive, stopAudio]);

  return { label, connected, error };
}
