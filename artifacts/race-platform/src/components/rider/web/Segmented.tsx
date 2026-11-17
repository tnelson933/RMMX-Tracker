import type { LucideIcon } from "lucide-react";

/** The app's pill segmented control: muted track, red fill on the active option. */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { key: T; label: string; icon?: LucideIcon }[];
  value: T;
  onChange: (key: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex rounded-full bg-[#2E2E2E] border border-[#3A3A3A] p-1">
      {options.map(({ key, label: text, icon: Icon }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 min-h-[40px] rounded-full text-[14px] font-bold transition-colors ${active ? "bg-[#B30000] text-white shadow" : "text-[#A8A8A8] hover:text-white"}`}
          >
            {Icon && <Icon size={14} />}
            {text}
          </button>
        );
      })}
    </div>
  );
}
