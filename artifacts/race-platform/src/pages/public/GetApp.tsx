import { useEffect } from "react";
import { Redirect } from "wouter";
import { APP_STORE_URL, PLAY_STORE_URL, phonePlatform } from "@/lib/appStores";

/**
 * /get-app: the one link the QR code and printed material use. An iPhone goes
 * to the App Store, an Android phone to Google Play, anything else to the
 * /rider-app page. (When the API serves the site it redirects before this loads.)
 */
export default function GetApp() {
  const platform = phonePlatform();
  useEffect(() => {
    if (platform === "ios") window.location.replace(APP_STORE_URL);
    else if (platform === "android") window.location.replace(PLAY_STORE_URL);
  }, [platform]);
  if (platform === "other") return <Redirect to="/rider-app" replace />;
  return (
    <p className="p-8 text-center text-muted-foreground" role="status">
      Opening the app store… <a className="underline" href={platform === "ios" ? APP_STORE_URL : PLAY_STORE_URL}>Tap here if nothing happens</a>.
    </p>
  );
}
