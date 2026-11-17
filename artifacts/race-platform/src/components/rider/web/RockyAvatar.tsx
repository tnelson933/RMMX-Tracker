import { Wrench } from "lucide-react";

/** Rocky's badge (rider-app/components/RockyAvatar.tsx): a wrench in a glowing red ring with an "online" dot. */
export function RockyAvatar({ size = 40, online = true }: { size?: number; online?: boolean }) {
  const dot = Math.max(8, Math.round(size * 0.24));
  const ring = Math.max(2, Math.round(size * 0.06));
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <span
        className="flex items-center justify-center rounded-full bg-[#B30000] text-white"
        style={{
          width: size, height: size,
          boxShadow: `0 0 0 ${ring}px rgba(179,0,0,0.3), 0 0 ${Math.round(size * 0.35)}px rgba(179,0,0,0.55)`,
        }}
      >
        <Wrench size={Math.round(size * 0.46)} />
      </span>
      {online && (
        <span
          className="absolute rounded-full bg-[#22c55e] border-2 border-[#242424]"
          style={{ right: -1, bottom: -1, width: dot, height: dot }}
        />
      )}
    </span>
  );
}
