// Bike manufacturer picker drawn as design-system pills: 2px #8C8C8C border,
// selected = 2px #242424 border on #F2F2F2 with the label unchanged. The
// manufacturer's color shows as a dot so the pill itself stays on-brand.
export function BikeBrandChips({
  brands,
  value,
  onChange,
}: {
  brands: ReadonlyArray<{ name: string; color: string }>;
  value: string | null | undefined;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {brands.map(brand => {
        const selected = value === brand.name;
        return (
          <button
            key={brand.name}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? "" : brand.name)}
            className={`inline-flex items-center gap-2 rounded-full border-2 px-4 min-h-[44px] text-[15px] font-bold text-[#333] transition-colors ${
              selected ? "border-[#242424] bg-[#F2F2F2]" : "border-[#8C8C8C] bg-white hover:bg-[#F2F2F2] hover:border-[#333]"
            }`}
          >
            <span aria-hidden className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: brand.color }} />
            {brand.name}
          </button>
        );
      })}
    </div>
  );
}
