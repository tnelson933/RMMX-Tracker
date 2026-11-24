import { useEffect, useState } from "react";
import { Link } from "wouter";
import { QRCodeSVG } from "qrcode.react";
import { Bell, ChevronRight, Heart, QrCode, Timer, Trophy, Video, Wrench } from "lucide-react";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { phonePlatform } from "@/lib/appStores";
import { StoreButtons } from "@/components/AppStoreButtons";

/**
 * /rider-app: what the free RM Roost rider app does and where to get it.
 * Phones get their own store first; computers get a QR code for /get-app,
 * which sends each phone to its store. No made-up screenshots: the phone
 * shows the app's real layout (tabs and colours) without data.
 */

const FEATURES = [
  { icon: Trophy, title: "Results the moment you finish", text: "Every moto, lap times, and your series standings, kept as your race history." },
  { icon: Timer, title: "Live timing", text: "Positions and laps as the race runs, from the pits or the couch." },
  { icon: Heart, title: "Follow riders", text: "Follow friends and teammates and see their results as they come in." },
  { icon: QrCode, title: "Quick Check-In", text: "Check in on race day from your phone, with alerts when your race is up." },
  { icon: Video, title: "Go Live", text: "Stream your race from the fence to the riders who follow you." },
  { icon: Wrench, title: "Bike maintenance", text: "Log oil changes and rebuilds by hours, and see what's due next." },
];

/** The app's home screen shape in its own colours, without data. */
function PhoneFrame() {
  const bar = (w: string, tone = "bg-white/15") => <span className={`block h-2.5 rounded-full ${tone}`} style={{ width: w }} />;
  const tabs = ["Home", "My Races", "Results", "Train", "Profile"];
  return (
    <div aria-hidden className="relative mx-auto w-[260px] sm:w-[280px] select-none">
      <div className="rounded-[44px] bg-[#0a0a0a] p-3 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.6)] ring-1 ring-white/10">
        <div className="relative rounded-[34px] bg-[#161616] overflow-hidden h-[540px] flex flex-col">
          <div className="flex justify-center pt-2.5"><span className="h-5 w-24 rounded-full bg-black" /></div>
          <div className="px-5 pt-4 pb-3 flex items-center justify-between">
            <img src={`${import.meta.env.BASE_URL}brand/rm-roost-banner-640.png`} alt="" className="h-7 w-auto" />
            <Bell size={16} className="text-white/60" />
          </div>
          <div className="px-4 space-y-3 flex-1">
            <div className="rounded-2xl bg-primary p-4 space-y-2.5">
              <span className="block font-heading font-bold uppercase text-[11px] tracking-[2px] text-white/85">Next gate drop</span>
              {bar("70%", "bg-white/80")}
              {bar("45%", "bg-white/45")}
              <span className="mt-1 inline-flex h-7 w-28 rounded-full bg-white/90" />
            </div>
            <div className="rounded-2xl bg-[#242424] p-4 space-y-2.5">
              <span className="flex items-center gap-2 font-heading font-bold uppercase text-[11px] tracking-[2px] text-white/80">
                <span className="h-2 w-2 rounded-full bg-primary" /> Live now
              </span>
              {[0, 1, 2].map(i => (
                <span key={i} className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-md bg-white/10 shrink-0" />
                  {bar(`${68 - i * 12}%`)}
                </span>
              ))}
            </div>
            <div className="rounded-2xl bg-[#242424] p-4 space-y-2.5">
              <span className="block font-heading font-bold uppercase text-[11px] tracking-[2px] text-white/80">Following</span>
              {bar("80%")}
              {bar("55%")}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-5 border-t border-white/10 bg-[#121212] px-1 pt-2 pb-4">
            {tabs.map((t, i) => (
              <span key={t} className={`flex flex-col items-center gap-1 text-center leading-tight text-[9px] font-heading font-bold uppercase tracking-[0.3px] ${i === 0 ? "text-white" : "text-white/45"}`}>
                <span className={`h-1 w-5 rounded-full ${i === 0 ? "bg-primary" : "bg-transparent"}`} />
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RiderAppLanding() {
  // The QR code is for people on a computer; phones get the store buttons.
  const [getAppUrl, setGetAppUrl] = useState("");
  const [onPhone, setOnPhone] = useState(false);
  useEffect(() => {
    setGetAppUrl(`${window.location.origin}/get-app`);
    setOnPhone(phonePlatform() !== "other");
  }, []);

  return (
    <PublicLayout>
      <section className="relative overflow-hidden bg-[#242424] text-white border-b-[3px] border-primary">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.16] mix-blend-screen bg-cover bg-center"
          style={{ backgroundImage: `url(${import.meta.env.BASE_URL}brand/topo.jpg)` }}
        />
        <div className="container mx-auto px-4 relative z-10 py-10 sm:py-16 grid lg:grid-cols-[1fr_auto] gap-10 lg:gap-16 items-center">
          <div className="max-w-2xl">
            <div className="flex items-center gap-3 mb-5">
              <span className="w-[6px] self-stretch bg-primary -skew-x-[18deg]" aria-hidden />
              <span className="font-heading font-bold text-sm uppercase tracking-[2px] text-[#BDBDBD]">
                The RM Roost rider app &middot; Free
              </span>
            </div>
            <h1 className="font-heading font-extrabold uppercase text-[36px] sm:text-[56px] leading-[1] mb-5">
              Your race day,<br />
              <span className="inline-block bg-primary text-white px-3 mt-2 -skew-x-[8deg]"><span className="inline-block skew-x-[8deg]">in your pocket.</span></span>
            </h1>
            <p className="text-base sm:text-lg leading-[1.7] text-white/80 mb-8 max-w-xl">
              Register for races in a couple of taps, check in from the pits, follow live timing, and get your results the moment the moto ends.
            </p>
            <StoreButtons />
            <p className="mt-5 text-sm text-white/70">
              Rather use a browser?{" "}
              <Link href="/rider/login" className="text-white font-semibold underline underline-offset-4 decoration-white/50 hover:decoration-white">
                Use the website instead
              </Link>
            </p>
          </div>

          <div className="flex flex-col sm:flex-row lg:flex-col items-center gap-8">
            <PhoneFrame />
          </div>
        </div>
      </section>

      {/* Desktop visitors: scan to get it on your phone */}
      {!onPhone && getAppUrl && (
        <section className="container mx-auto px-4 -mt-px">
          <div className="mt-10 flex flex-col sm:flex-row items-center gap-6 sm:gap-8 rounded-[14px] border-2 border-[#ECECEC] bg-white p-6 sm:p-8 max-w-3xl">
            <div className="bg-white p-3 rounded-xl border border-[#E0E0E0] shrink-0">
              <QRCodeSVG value={getAppUrl} size={148} level="M" title="QR code: get the RM Roost rider app" />
            </div>
            <div className="text-center sm:text-left">
              <h2 className="font-heading font-extrabold uppercase text-2xl mb-2">On a computer? Scan this with your phone.</h2>
              <p className="text-muted-foreground">
                Point your phone's camera at the code. It opens the App Store on an iPhone and Google Play on Android.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="container mx-auto px-4 py-12 sm:py-16">
        <h2 className="font-heading font-extrabold uppercase text-[28px] sm:text-[36px] leading-tight mb-8 max-w-2xl">
          Everything for race day, in one app
        </h2>
        <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-0 border-t-2 border-[#ECECEC]">
          {FEATURES.map(f => (
            <li key={f.title} className="flex gap-4 py-6 border-b-2 border-[#ECECEC]">
              <span className="w-11 h-11 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
                <f.icon size={20} className="text-primary" aria-hidden />
              </span>
              <span>
                <strong className="block font-heading font-bold uppercase tracking-[0.5px] text-[17px] text-[#242424]">{f.title}</strong>
                <span className="block text-[15px] leading-relaxed text-muted-foreground mt-1">{f.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="container mx-auto px-4 pb-16">
        <div className="bg-[#1A1A1A] text-white rounded-[12px] border-b-[3px] border-primary p-8 sm:p-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <h2 className="font-heading font-extrabold uppercase text-[26px] sm:text-3xl mb-2">Get the free app</h2>
            <p className="text-white/75 max-w-xl">For iPhone and Android. Sign in with the same rider account you use on the website.</p>
          </div>
          <div className="flex flex-col gap-3 lg:items-end">
            <StoreButtons />
            <Link href="/rider/login" className="inline-flex items-center gap-1 text-sm font-semibold text-white/80 hover:text-white">
              Use the website instead <ChevronRight size={14} aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
