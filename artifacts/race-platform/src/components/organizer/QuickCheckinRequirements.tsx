import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * What riders need before they can Quick Check-In from the rider app.
 * Mirrors api-server lib/quickCheckinRequirements.ts: every key is on unless
 * the organizer turns it off.
 */
export interface QuickCheckinRequirements {
  paid: boolean;
  timing: boolean;
  waiver: boolean;
  pickup: boolean;
  atTrack: boolean;
}

export const DEFAULT_QUICK_CHECKIN_REQUIREMENTS: QuickCheckinRequirements = {
  paid: true, timing: true, waiver: true, pickup: true, atTrack: true,
};

const KEYS = ["paid", "timing", "waiver", "pickup", "atTrack"] as const;

/** An event's stored requirements with every unset one on. */
export function toQuickCheckinRequirements(stored: unknown): QuickCheckinRequirements {
  const out = { ...DEFAULT_QUICK_CHECKIN_REQUIREMENTS };
  if (stored && typeof stored === "object") {
    for (const key of KEYS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "boolean") out[key] = v;
    }
  }
  return out;
}

interface EventContext {
  timingTechnology: string;
  paymentEnabled: boolean;
  requiresWaiver: boolean;
}

function rows(ctx: EventContext) {
  const isRfid = ctx.timingTechnology === "rfid";
  return [
    {
      key: "paid" as const,
      label: "Registration paid",
      desc: ctx.paymentEnabled
        ? "Riders who haven't finished paying online check in at the gate."
        : "Only applies when you collect payments online.",
    },
    {
      key: "timing" as const,
      label: isRfid ? "RFID tag assigned" : "Transponder number on file",
      desc: isRfid
        ? "Riders without an RFID tag for this event check in at the gate."
        : "Riders without a transponder number check in at the gate. Turn off to assign numbers later.",
    },
    {
      key: "waiver" as const,
      label: "Required waivers signed",
      desc: ctx.requiresWaiver
        ? "Riders sign in the rider app first, or at the gate."
        : "This event doesn't require a waiver right now.",
    },
    {
      key: "pickup" as const,
      label: "Nothing to pick up",
      desc: "Riders who rented or bought a transponder, or bought an RFID sticker, get it at the gate.",
    },
    {
      key: "atTrack" as const,
      label: "At the track",
      desc: "Their phone must be within 1 mile of the track. Turn off to let riders check in from anywhere on race day.",
    },
  ];
}

/** One line for the forms: "All requirements" or what's turned off. */
export function quickCheckinRequirementsSummary(req: QuickCheckinRequirements, timingTechnology: string): string {
  const off = rows({ timingTechnology, paymentEnabled: true, requiresWaiver: true })
    .filter(r => !req[r.key]).map(r => r.label.toLowerCase());
  if (off.length === 0) return "Riders must meet every requirement.";
  if (off.length === KEYS.length) return "No requirements: any registered rider can check in on race day.";
  return `Not required: ${off.join(", ")}.`;
}

export function QuickCheckinRequirementsDialog({
  open,
  onOpenChange,
  value,
  onSave,
  context,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: QuickCheckinRequirements;
  onSave: (value: QuickCheckinRequirements) => void;
  context: EventContext;
  saving?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // Start from the saved setting each time it opens.
  useEffect(() => { if (open) setDraft(value); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading uppercase tracking-wide">Quick Check-In requirements</DialogTitle>
          <DialogDescription>
            What riders need before they can check themselves in from the rider app. Uncheck anything you don't need. Riders who don't qualify check in at the gate.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {rows(context).map(r => (
            <label key={r.key} htmlFor={`qc-req-${r.key}`} className="flex items-start gap-3 rounded-lg border bg-background px-4 py-3 cursor-pointer hover:bg-muted/40">
              <Checkbox
                id={`qc-req-${r.key}`}
                checked={draft[r.key]}
                onCheckedChange={v => setDraft(d => ({ ...d, [r.key]: v === true }))}
                className="mt-0.5"
              />
              <span className="space-y-0.5 leading-snug">
                <span className="block text-sm font-semibold">{r.label}</span>
                <span className="block text-xs text-muted-foreground">{r.desc}</span>
              </span>
            </label>
          ))}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={() => setDraft(DEFAULT_QUICK_CHECKIN_REQUIREMENTS)}>Check all</Button>
          <Button type="button" onClick={() => onSave(draft)} disabled={saving}>Save requirements</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
