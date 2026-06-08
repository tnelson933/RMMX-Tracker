import { WifiOff, Wifi } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useOfflineStatus } from "@/hooks/useOfflineStatus";
import { useState, useEffect } from "react";

export function OfflineBanner() {
  const { isOffline, isOnline } = useOfflineStatus();
  const [showReconnected, setShowReconnected] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (isOffline) {
      setWasOffline(true);
    }
  }, [isOffline]);

  useEffect(() => {
    if (isOnline && wasOffline) {
      setShowReconnected(true);
      const t = setTimeout(() => {
        setShowReconnected(false);
        setWasOffline(false);
      }, 3000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isOnline, wasOffline]);

  return (
    <AnimatePresence>
      {isOffline && (
        <motion.div
          key="offline"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="bg-amber-500 text-amber-950 px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium">
            <WifiOff size={15} className="shrink-0" />
            <span>
              You&apos;re offline — data from your last visit is still
              available. Changes will sync when connection returns.
            </span>
          </div>
        </motion.div>
      )}

      {showReconnected && !isOffline && (
        <motion.div
          key="reconnected"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="bg-green-600 text-white px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium">
            <Wifi size={15} className="shrink-0" />
            <span>Back online — syncing latest data.</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
