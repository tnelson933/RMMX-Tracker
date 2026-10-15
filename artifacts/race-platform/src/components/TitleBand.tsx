import type { ReactNode } from "react";

// Dark page title band from the Rocky Mountain ATV/MC Design System (TitleBand):
// #1A1A1A with a 3px red underline, skewed red slash, Barlow 800 uppercase H1.
export function TitleBand({
  title,
  eyebrow,
  subtitle,
  children,
  containerClassName = "",
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  /** Match the page body's max width, e.g. "max-w-5xl". */
  containerClassName?: string;
}) {
  return (
    <div className="bg-[#1A1A1A] border-b-[3px] border-primary text-white">
      <div className={`container mx-auto px-4 py-8 sm:py-10 ${containerClassName} flex flex-col md:flex-row md:items-end md:justify-between gap-6`}>
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[13px] text-[#BDBDBD] uppercase tracking-[2px] mb-3">{eyebrow}</div>
          )}
          <div className="flex items-stretch gap-3.5">
            <span aria-hidden className="w-[6px] bg-primary -skew-x-[18deg] shrink-0" />
            <h1 className="m-0 font-heading font-extrabold uppercase text-[30px] sm:text-[52px] leading-none tracking-normal">
              {title}
            </h1>
          </div>
          {subtitle && <p className="text-white/75 mt-4 text-base leading-[1.7] max-w-2xl">{subtitle}</p>}
        </div>
        {children && <div className="shrink-0 w-full md:w-auto">{children}</div>}
      </div>
    </div>
  );
}
