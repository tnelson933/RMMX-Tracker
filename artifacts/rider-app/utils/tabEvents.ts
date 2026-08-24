type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

export function onTabReset(tab: string, listener: Listener): () => void {
  if (!listeners.has(tab)) {
    listeners.set(tab, new Set());
  }

  listeners.get(tab)!.add(listener);
  return () => listeners.get(tab)?.delete(listener);
}

export function emitTabReset(tab: string): void {
  listeners.get(tab)?.forEach((listener) => listener());
}