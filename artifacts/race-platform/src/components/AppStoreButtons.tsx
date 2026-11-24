import { Apple } from "lucide-react";
import { APP_STORE_URL, PLAY_STORE_URL, phonePlatform } from "@/lib/appStores";

function PlayMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor">
      <path d="M4.2 2.4c-.3.3-.4.7-.4 1.2v16.8c0 .5.1.9.4 1.2l9.3-9.6-9.3-9.6Zm10.4 10.7 2.6 2.7-11.5 6.6 8.9-9.3Zm0-2.2L5.7 1.6l11.5 6.6-2.6 2.7Zm3.8-2 3.2 1.8c.9.5.9 1.9 0 2.4l-3.2 1.8-2.8-3 2.8-3Z" />
    </svg>
  );
}

/** App Store and Google Play buttons, the visitor's own phone's store first. `tone` is the surface they sit on. */
export function StoreButtons({ tone = "dark" }: { tone?: "dark" | "light" }) {
  const platform = phonePlatform();
  const base = "inline-flex items-center justify-center gap-3 min-h-[56px] px-6 rounded-full font-heading font-bold uppercase tracking-[1px] text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
  const solid = tone === "dark"
    ? "bg-white text-[#242424] hover:bg-[#F2F2F2] focus-visible:ring-white focus-visible:ring-offset-[#242424]"
    : "bg-[#242424] text-white hover:bg-black focus-visible:ring-[#242424]";
  const apple = (
    <a key="ios" href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" className={`${base} ${solid}`}>
      <Apple size={20} aria-hidden />
      <span className="flex flex-col items-start leading-none">
        <span className="text-[11px] font-sans normal-case tracking-normal opacity-75">Download on the</span>
        App Store
      </span>
    </a>
  );
  const google = (
    <a key="android" href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" className={`${base} ${solid}`}>
      <PlayMark size={19} />
      <span className="flex flex-col items-start leading-none">
        <span className="text-[11px] font-sans normal-case tracking-normal opacity-75">Get it on</span>
        Google Play
      </span>
    </a>
  );
  return (
    <div className="flex flex-col min-[420px]:flex-row gap-3">
      {platform === "android" ? [google, apple] : [apple, google]}
    </div>
  );
}

