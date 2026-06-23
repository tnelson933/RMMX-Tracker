import { useState, useEffect, useCallback } from "react";

export type LocationStatus = "pending" | "granted" | "denied" | "unavailable";

export interface UserLocation {
  lat: number;
  lng: number;
  status: LocationStatus;
}

export function useUserLocation(): (UserLocation | { status: LocationStatus }) & { retry: () => void } {
  const [result, setResult] = useState<{ lat?: number; lng?: number; status: LocationStatus }>({
    status: "pending",
  });

  const request = useCallback(() => {
    if (!navigator.geolocation) {
      setResult({ status: "unavailable" });
      return;
    }
    setResult(prev => ({ ...prev, status: "pending" }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setResult({ lat: pos.coords.latitude, lng: pos.coords.longitude, status: "granted" });
      },
      () => {
        setResult({ status: "denied" });
      },
      { timeout: 8000, maximumAge: 300_000 }
    );
  }, []);

  useEffect(() => {
    request();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...(result as UserLocation | { status: LocationStatus }), retry: request };
}
