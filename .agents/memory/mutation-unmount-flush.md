---
name: useMutation unmount flush
description: TanStack Query v5 mutation observers are destroyed on component unmount — .mutate() silently does nothing if called after that point.
---

## Rule
Never call `useMutation`'s `.mutate()` inside an unmount cleanup (`useEffect` with `[]` deps, return cleanup function). The mutation observer is destroyed when the component unmounts, so the call silently drops without making a network request.

**Why:** TanStack Query v5 ties the `mutate` function to a `MutationObserver` instance that is destroyed when the component unmounts. Calling `mutate` after destruction produces no error and no network request.

**How to apply:** For any "flush on unmount" pattern (save-before-leave, persist-on-navigate), use a raw `fetch` call with `credentials: "include"` instead of the mutation hook. Duplicate the change-detection logic using refs (not state) so it works synchronously in the cleanup.

## Example pattern (Motos.tsx min-lap unmount flush)
```tsx
useEffect(() => {
  return () => {
    // Don't use updateEventMutation.mutate() here — observer is gone.
    // Read current values from refs (not state, which is stale in cleanup).
    const inputs = minLapInputsRef.current;
    const eid = currentEventIdRef.current;
    if (!eid) return;
    const newMinLapTimes: Record<string, number> = {};
    for (const [cls, raw] of Object.entries(inputs)) {
      const ms = parseMinLapTime(raw);
      if (ms != null) newMinLapTimes[cls] = ms;
    }
    const committed = lastCommittedRef.current;
    const hasChange = /* … diff check … */;
    if (!hasChange) return;
    fetch(`/api/events/${eid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minLapTimes: newMinLapTimes }),
      credentials: "include",
    }).catch(() => {});
  };
}, []);
```
