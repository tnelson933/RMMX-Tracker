import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCompleteTour, getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import {
  Flag,
  Users,
  Wifi,
  BarChart3,
  Globe,
  Calendar,
  PartyPopper,
  ChevronRight,
  ChevronLeft,
  X,
} from "lucide-react";

interface TourStep {
  icon: React.ReactNode;
  accent: string;
  title: string;
  description: string;
  detail: string;
}

const STEPS: TourStep[] = [
  {
    icon: <PartyPopper size={36} />,
    accent: "from-red-600 to-red-700",
    title: "Welcome to the Platform",
    description: "Your club is all set up and ready to go.",
    detail:
      "This two-minute tour covers the five core areas of the platform. You can skip it now and replay it any time from the Help menu.",
  },
  {
    icon: <Calendar size={36} />,
    accent: "from-blue-600 to-blue-700",
    title: "Events",
    description: "Create and run your race events end-to-end.",
    detail:
      "From the Events page you can create an event, open registration, manage rider check-ins on race day, enter moto results, and publish the final standings publicly — all from one place.",
  },
  {
    icon: <Users size={36} />,
    accent: "from-violet-600 to-violet-700",
    title: "Riders",
    description: "Your club's rider database lives here.",
    detail:
      "Add riders, track their history across events, and assign RFID transponder numbers so the timing system knows who's who on the track.",
  },
  {
    icon: <Wifi size={36} />,
    accent: "from-amber-600 to-amber-700",
    title: "RFID Timing",
    description: "Plug-and-play live lap scoring.",
    detail:
      "Once your RFID readers are configured (see Reader Setup), the system automatically records every lap crossing and builds a live leaderboard in real time. No manual entry needed.",
  },
  {
    icon: <BarChart3 size={36} />,
    accent: "from-emerald-600 to-emerald-700",
    title: "Series & Points",
    description: "Run a championship series across multiple events.",
    detail:
      "Define a points structure, link events to the series, and the platform calculates and displays a running championship leaderboard automatically after each event.",
  },
  {
    icon: <Globe size={36} />,
    accent: "from-cyan-600 to-cyan-700",
    title: "Public Results",
    description: "Fans and riders see results at your public URL.",
    detail:
      "Every published event appears on the public Results page — no login required. Share the link on social media so your community can follow along live or check final standings after the race.",
  },
  {
    icon: <Flag size={36} />,
    accent: "from-green-600 to-green-700",
    title: "You're Ready to Race!",
    description: "That's the full tour.",
    detail:
      "Start by creating your first event. If you need help at any point, the Reader Setup guide walks you through hardware configuration step by step. Good luck out there!",
  },
];

interface ProductTourProps {
  onComplete: () => void;
}

export function ProductTour({ onComplete }: ProductTourProps) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [dismissed, setDismissed] = useState(false);
  const queryClient = useQueryClient();
  const { mutate: completeTour } = useCompleteTour({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      },
      onError: (err: any) => {
        if (err?.status === 401) {
          window.location.href = "/login";
        }
      },
    },
  });

  const current = STEPS[step];
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;

  function go(next: number) {
    setDir(next > step ? 1 : -1);
    setStep(next);
  }

  function finish() {
    setDismissed(true);
    completeTour();
    onComplete();
  }

  if (dismissed) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg">

        {/* Skip button */}
        <button
          onClick={finish}
          className="absolute -top-10 right-0 text-white/50 hover:text-white/90 flex items-center gap-1.5 text-sm transition-colors"
        >
          <X size={14} /> Skip tour
        </button>

        {/* Card */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden">

          {/* Accent header */}
          <div className={`bg-gradient-to-r ${current.accent} px-8 py-8 flex flex-col items-center text-white text-center`}>
            <AnimatePresence mode="wait" custom={dir}>
              <motion.div
                key={step}
                custom={dir}
                initial={{ opacity: 0, x: dir * 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: dir * -40 }}
                transition={{ duration: 0.22, ease: "easeInOut" }}
                className="flex flex-col items-center gap-3"
              >
                <div className="bg-white/20 rounded-2xl p-4">
                  {current.icon}
                </div>
                <div>
                  <p className="text-white/70 text-xs font-heading uppercase tracking-widest mb-1">
                    Step {step + 1} of {STEPS.length}
                  </p>
                  <h2 className="text-2xl font-heading font-bold">{current.title}</h2>
                  <p className="text-white/85 mt-1 text-sm font-medium">{current.description}</p>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Body */}
          <div className="px-8 py-6">
            <AnimatePresence mode="wait" custom={dir}>
              <motion.p
                key={step}
                custom={dir}
                initial={{ opacity: 0, y: dir * 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: dir * -12 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="text-muted-foreground text-sm leading-relaxed text-center"
              >
                {current.detail}
              </motion.p>
            </AnimatePresence>

            {/* Progress dots */}
            <div className="flex justify-center gap-1.5 mt-6">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => go(i)}
                  className={`rounded-full transition-all duration-200 ${
                    i === step
                      ? "w-6 h-2 bg-primary"
                      : "w-2 h-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300"
                  }`}
                />
              ))}
            </div>

            {/* Navigation */}
            <div className="flex items-center justify-between mt-5 gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => go(step - 1)}
                disabled={isFirst}
                className="gap-1.5"
              >
                <ChevronLeft size={15} /> Back
              </Button>

              {isLast ? (
                <Button
                  size="sm"
                  onClick={finish}
                  className="gap-1.5 bg-green-600 hover:bg-green-700 text-white font-heading uppercase tracking-wider px-6"
                >
                  Let's go! <Flag size={14} />
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => go(step + 1)}
                  className="gap-1.5 font-heading uppercase tracking-wider px-5"
                >
                  Next <ChevronRight size={15} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
