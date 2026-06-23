import { useState, useEffect, useLayoutEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCompleteTour, getGetMeQueryKey } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronRight, ChevronLeft, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TourStep {
  selector?: string;
  title: string;
  description: string;
  side?: "right" | "left" | "bottom" | "top";
}

const ALL_STEPS: TourStep[] = [
  {
    title: "👋 Welcome to RM Tracker",
    description:
      "You're all set up. This quick tour highlights everything available in the sidebar — only takes a minute.",
  },
  {
    selector: '[data-tour="nav-events"]',
    side: "right",
    title: "Events",
    description:
      "Create events, open online registration, manage check-ins on race day, run motos, enter results, and publish standings — all in one place.",
  },
  {
    selector: '[data-tour="nav-practice"]',
    side: "right",
    title: "Practice Mode",
    description:
      "Run standalone practice sessions with live lap timing. Riders get a real-time best-lap board without a full race event.",
  },
  {
    selector: '[data-tour="nav-riders"]',
    side: "right",
    title: "Riders",
    description:
      "Your club's rider database. Assign RFID or MyLaps transponder numbers here so the timing system knows who's who on the track.",
  },
  {
    selector: '[data-tour="nav-series"]',
    side: "right",
    title: "Series & Points",
    description:
      "Run a championship across multiple events. Link events to a series and the platform calculates running standings automatically after each round.",
  },
  {
    selector: '[data-tour="nav-payments"]',
    side: "right",
    title: "Payments",
    description:
      "Accept entry fees online via Stripe Connect. Payouts deposit directly into your club's bank account — no middleman, no delays.",
  },
  {
    selector: '[data-tour="nav-discount-codes"]',
    side: "right",
    title: "Discount Codes",
    description:
      "Create promo codes, comp entries, and category-based discounts. Supports fixed-dollar, percentage, and full-comp codes.",
  },
  {
    selector: '[data-tour="nav-notifications"]',
    side: "right",
    title: "Notifications",
    description:
      "Riders automatically receive 'Next Up' and '3 Races Away' push alerts as motos complete. You can also send custom broadcasts to your entire club.",
  },
  {
    selector: '[data-tour="nav-race-day-display"]',
    side: "right",
    title: "Race Day Display",
    description:
      "A TV-ready screen for announcers and pit boards showing live gate lists, race status, and countdowns — no login required.",
  },
  {
    selector: '[data-tour="nav-rfid"]',
    side: "right",
    title: "Reader Setup",
    description:
      "Configure your RFID or MyLaps timing readers. The platform supports both transponder technologies — switch per-event as needed.",
  },
  {
    selector: '[data-tour="nav-offline"]',
    side: "right",
    title: "Offline Mode",
    description:
      "Run events at remote tracks without internet. Sync everything back to the cloud once you're online — nothing is lost.",
  },
  {
    selector: '[data-tour="ai-assistant"]',
    side: "left",
    title: "AI Assistant",
    description:
      "Your built-in AI knows your current event and can help with any task — creating events, setting up timing, or answering questions.",
  },
  {
    title: "You're Ready to Race! 🏁",
    description:
      "That's the full tour. Start by creating your first event. You can replay this tour any time from Help in the sidebar.",
  },
];

const PAD = 10;

interface Rect { left: number; top: number; width: number; height: number; right: number; bottom: number; }

interface ProductTourProps {
  onComplete: () => void;
}

export function ProductTour({ onComplete }: ProductTourProps) {
  const queryClient = useQueryClient();
  const { mutate: completeTour } = useCompleteTour({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() }),
      onError: (err: any) => { if (err?.status === 401) window.location.href = "/login"; },
    },
  });

  const [steps, setSteps] = useState<TourStep[]>([]);
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const available = ALL_STEPS.filter(
        s => !s.selector || document.querySelector(s.selector) !== null,
      );
      setSteps(available);
    }, 350);
    return () => clearTimeout(timer);
  }, []);

  const current = steps[step];

  useLayoutEffect(() => {
    if (!current?.selector) { setTargetRect(null); return; }
    const el = document.querySelector(current.selector);
    if (el) setTargetRect(el.getBoundingClientRect() as Rect);
    else setTargetRect(null);
  }, [current]);

  useEffect(() => {
    const onResize = () => {
      if (!current?.selector) return;
      const el = document.querySelector(current.selector);
      if (el) setTargetRect(el.getBoundingClientRect() as Rect);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [current]);

  const finish = useCallback(() => {
    setDismissed(true);
    completeTour();
    onComplete();
  }, [completeTour, onComplete]);

  const isLast = step === steps.length - 1;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" && !isLast) setStep(s => s + 1);
      if (e.key === "ArrowLeft" && step > 0) setStep(s => s - 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finish, isLast, step]);

  if (dismissed || steps.length === 0 || !current) return null;

  const hasTarget = !!targetRect;

  const hx = hasTarget ? targetRect!.left - PAD : 0;
  const hy = hasTarget ? targetRect!.top - PAD : 0;
  const hw = hasTarget ? targetRect!.width + PAD * 2 : 0;
  const hh = hasTarget ? targetRect!.height + PAD * 2 : 0;

  const popoverStyle: React.CSSProperties = { position: "fixed", width: 292 };

  if (!hasTarget) {
    popoverStyle.top = "50%";
    popoverStyle.left = "50%";
    popoverStyle.transform = "translate(-50%, -50%)";
  } else {
    const r = targetRect!;
    const side = current.side ?? "right";
    const vCenter = Math.max(12, Math.min(r.top + r.height / 2 - 90, window.innerHeight - 200));

    if (side === "right") {
      popoverStyle.top = vCenter;
      popoverStyle.left = r.right + PAD + 16;
    } else if (side === "left") {
      popoverStyle.top = vCenter;
      popoverStyle.left = Math.max(8, r.left - 292 - PAD - 16);
    } else if (side === "bottom") {
      popoverStyle.top = r.bottom + PAD + 12;
      popoverStyle.left = Math.max(8, Math.min(r.left, window.innerWidth - 300));
    } else {
      popoverStyle.top = Math.max(8, r.top - PAD - 12 - 200);
      popoverStyle.left = Math.max(8, Math.min(r.left, window.innerWidth - 300));
    }
  }

  const arrowSide = current.side;
  const arrowStyle: React.CSSProperties = { position: "absolute" };
  if (hasTarget && arrowSide === "right") {
    arrowStyle.left = -7;
    arrowStyle.top = "50%";
    arrowStyle.transform = "translateY(-50%)";
  } else if (hasTarget && arrowSide === "left") {
    arrowStyle.right = -7;
    arrowStyle.top = "50%";
    arrowStyle.transform = "translateY(-50%)";
  }

  return (
    <div className="fixed inset-0 z-[60]">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="pointer-events-none"
        style={{ position: "fixed", inset: 0, width: "100%", height: "100%" }}
      >
        {hasTarget && (
          <defs>
            <mask id="tour-spotlight">
              <rect width="100%" height="100%" fill="white" />
              <rect x={hx} y={hy} width={hw} height={hh} rx="7" fill="black" />
            </mask>
          </defs>
        )}
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.72)"
          mask={hasTarget ? "url(#tour-spotlight)" : undefined}
        />
      </svg>

      {hasTarget && (
        <div
          className="pointer-events-none"
          style={{
            position: "fixed",
            left: hx - 2,
            top: hy - 2,
            width: hw + 4,
            height: hh + 4,
            borderRadius: 9,
            boxShadow: "0 0 0 2px hsl(var(--primary)), 0 0 0 4px hsl(var(--primary) / 0.3)",
            animation: "tour-pulse 1.8s ease-in-out infinite",
          }}
        />
      )}

      <div className="fixed inset-0 pointer-events-none" />

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, scale: 0.94, y: 5 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: -5 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          style={popoverStyle}
          className="z-[61] bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-border overflow-visible"
          onClick={e => e.stopPropagation()}
        >
          {hasTarget && arrowSide === "right" && (
            <div
              style={arrowStyle}
              className="w-3.5 h-3.5 bg-white dark:bg-gray-900 border-l border-b border-border rotate-45"
            />
          )}
          {hasTarget && arrowSide === "left" && (
            <div
              style={arrowStyle}
              className="w-3.5 h-3.5 bg-white dark:bg-gray-900 border-r border-t border-border rotate-45"
            />
          )}

          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-b border-border rounded-t-xl">
            <span className="text-[11px] font-heading font-bold uppercase tracking-widest text-muted-foreground">
              {step + 1} / {steps.length}
            </span>
            <button
              onClick={finish}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
            >
              <X size={13} />
            </button>
          </div>

          <div className="px-4 pt-3.5 pb-3">
            <h3 className="font-heading font-bold text-[15px] mb-1.5">{current.title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{current.description}</p>
          </div>

          <div className="flex justify-center gap-1 pb-1">
            {steps.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`rounded-full transition-all duration-200 ${
                  i === step
                    ? "w-5 h-1.5 bg-primary"
                    : "w-1.5 h-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(s => s - 1)}
              disabled={step === 0}
              className="gap-1 h-7 text-xs px-2"
            >
              <ChevronLeft size={13} /> Back
            </Button>
            {isLast ? (
              <Button
                size="sm"
                onClick={finish}
                className="gap-1 h-7 text-xs bg-green-600 hover:bg-green-700 text-white font-heading uppercase tracking-wider px-3"
              >
                Let's go! <Flag size={12} />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => setStep(s => s + 1)}
                className="gap-1 h-7 text-xs font-heading uppercase tracking-wider px-3"
              >
                Next <ChevronRight size={13} />
              </Button>
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      <button
        onClick={finish}
        className="fixed top-4 right-4 z-[61] text-white/50 hover:text-white/90 text-xs flex items-center gap-1.5 transition-colors bg-transparent border-0"
      >
        <X size={12} /> Skip tour
      </button>

      <style>{`
        @keyframes tour-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
