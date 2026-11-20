import { Bell, Radio, Timer, Video, Zap, QrCode } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { APP_STORE_URL, PLAY_STORE_URL, phonePlatform, rememberAppPromoDismissed } from "@/lib/appStores";

// Shown after a website registration ("You're in"): the free rider app makes
// the next registration a couple of taps, plus race-day perks.

const PERKS = [
  { icon: Zap, title: "Register in a couple of taps", text: "Your details, numbers and usual classes fill in for you." },
  { icon: Bell, title: "Know when you're up", text: "Alerts when your race is 3 away and when you're next." },
  { icon: QrCode, title: "Quick Check-In", text: "Check in on race day from your phone." },
  { icon: Timer, title: "Live results and lap times", text: "Follow your race, your friends and your series standings." },
  { icon: Video, title: "Go Live", text: "Stream your race to the riders who follow you." },
];

function StoreButtons({ compact = false }: { compact?: boolean }) {
  const platform = phonePlatform();
  const apple = (
    <Button key="ios" asChild className="flex-1 font-heading uppercase" variant={platform === "android" ? "outline" : "default"}>
      <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">App Store</a>
    </Button>
  );
  const google = (
    <Button key="android" asChild className="flex-1 font-heading uppercase" variant={platform === "ios" ? "outline" : "default"}>
      <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer">Google Play</a>
    </Button>
  );
  return (
    <div className={`flex gap-3 ${compact ? "" : "pt-1"}`}>
      {platform === "android" ? [google, apple] : [apple, google]}
    </div>
  );
}

/** The popup. Closing it keeps it away from this browser for two weeks. */
export function GetTheAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) rememberAppPromoDismissed(); onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading uppercase text-2xl">Next time, register in seconds</DialogTitle>
          <DialogDescription>
            Get the free RM Roost app. Sign in once and every registration after this one is a couple of taps.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 my-2">
          {PERKS.map(p => (
            <li key={p.title} className="flex gap-3">
              <span className="w-8 h-8 shrink-0 rounded-full bg-primary/10 flex items-center justify-center"><p.icon size={16} className="text-primary" /></span>
              <span className="text-sm leading-snug"><strong className="block">{p.title}</strong><span className="text-muted-foreground">{p.text}</span></span>
            </li>
          ))}
        </ul>
        <StoreButtons />
        <button type="button" className="text-sm text-muted-foreground underline mt-1" onClick={() => { rememberAppPromoDismissed(); onOpenChange(false); }}>
          Not now
        </button>
      </DialogContent>
    </Dialog>
  );
}

/** A small card under the confirmation, so the links stay after the popup is closed. */
export function GetTheAppCard() {
  return (
    <div className="rounded-[14px] border bg-card p-5 text-left space-y-3">
      <div className="flex items-center gap-2">
        <Radio size={16} className="text-primary" />
        <span className="font-heading font-bold uppercase">Get the free rider app</span>
      </div>
      <p className="text-sm text-muted-foreground">Quicker registration, race-day alerts, check-in and live results.</p>
      <StoreButtons compact />
    </div>
  );
}
