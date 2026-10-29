import { Button } from "@/components/ui/button";
import { Check, Plus } from "lucide-react";
import { RM_TRACKR_NAME, RM_TRACKR_PRICE } from "@/lib/rmTrackr";

/**
 * Shown under "Require transponder number? Yes" on the event forms. Riders
 * without their own transponder can only register if the event lets them rent
 * or buy one, so recommend offering both, with one-click buttons.
 */
export function TransponderRequirementTip({
  rentalsOffered,
  trackrOffered,
  onOfferRentals,
  onOfferTrackr,
}: {
  rentalsOffered: boolean;
  trackrOffered: boolean;
  onOfferRentals: () => void;
  onOfferTrackr: () => void;
}) {
  const allSet = rentalsOffered && trackrOffered;
  return (
    <div className={`text-xs rounded-md border px-3 py-2.5 mt-2 space-y-2 ${allSet ? "bg-green-50 border-green-200 text-green-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
      <p className="font-medium">
        {allSet
          ? "Riders without a transponder can rent or buy one when they register. Check-in shows who needs one handed out."
          : `Recommended: let riders rent or buy a transponder at registration. Without one of these, riders who don't own a transponder can't register.`}
      </p>
      {!allSet && (
        <div className="flex flex-wrap gap-2">
          {rentalsOffered ? (
            <span className="inline-flex items-center gap-1 font-semibold"><Check size={12} /> Rentals offered</span>
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs bg-background" onClick={onOfferRentals}>
              <Plus size={12} className="mr-1" /> Offer rentals
            </Button>
          )}
          {trackrOffered ? (
            <span className="inline-flex items-center gap-1 font-semibold"><Check size={12} /> {RM_TRACKR_NAME} for sale</span>
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs bg-background" onClick={onOfferTrackr}>
              <Plus size={12} className="mr-1" /> Sell the {RM_TRACKR_NAME} (${RM_TRACKR_PRICE})
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
