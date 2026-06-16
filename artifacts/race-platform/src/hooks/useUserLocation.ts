import { useState, useEffect } from "react";

export type LocationStatus = "pending" | "granted" | "denied" | "unavailable";

export interface UserLocation {
  lat: number;
  lng: number;
  status: LocationStatus;
}

export function useUserLocation(): UserLocation | { status: LocationStatus } {
  const [result, setResult] = useState<{ lat?: number; lng?: number; status: LocationStatus }>({
    status: "pending",
  });

  useEffect(() => {
    if (!navigator.geolocation) {
      setResult({ status: "unavailable" });
      return;
    }
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

  return result as UserLocation | { status: LocationStatus };
}
