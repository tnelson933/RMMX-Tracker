import { Globe, Mail, Phone } from "lucide-react";

export interface ClubContactInfo {
  clubName: string | null;
  clubLogoUrl?: string | null;
  clubContactEmail?: string | null;
  clubContactPhone?: string | null;
  clubWebsite?: string | null;
}

/** The website as typed ("rmatv.com" or "https://…") as a link, or null when it isn't one. */
function websiteHref(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v || /\s/.test(v)) return null;
  const href = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { return new URL(href).protocol.startsWith("http") ? href : null; } catch { return null; }
}

/**
 * Who runs the event and how to reach them (the club's own profile details).
 * Shown on the registration page and the event page before race day.
 */
export function EventClubContact({ info, compact = false }: { info: ClubContactInfo; compact?: boolean }) {
  const email = info.clubContactEmail?.trim() || null;
  const phone = info.clubContactPhone?.trim() || null;
  const site = websiteHref(info.clubWebsite);
  if (!info.clubName && !email && !phone && !site) return null;
  return (
    <div className="flex items-start gap-4 min-w-0">
      {info.clubLogoUrl && !compact && (
        <img src={info.clubLogoUrl} alt="" className="h-12 w-12 shrink-0 rounded-[10px] border border-[#ECECEC] bg-white object-contain p-1" />
      )}
      <div className="min-w-0 space-y-1">
        <div className="text-[13px] font-bold uppercase tracking-[1.5px] text-[#555]">Hosted by</div>
        <div className="font-heading font-bold text-lg leading-tight text-[#242424] break-words">{info.clubName ?? "The organizer"}</div>
        {(email || phone || site) && (
          <ul className="flex flex-col gap-1 pt-1 text-[15px]">
            {email && (
              <li>
                <a href={`mailto:${email}`} className="inline-flex items-center gap-2 text-[#242424] underline-offset-2 hover:underline break-all">
                  <Mail size={15} aria-hidden className="shrink-0 text-[#555]" /> {email}
                </a>
              </li>
            )}
            {phone && (
              <li>
                <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-2 text-[#242424] underline-offset-2 hover:underline">
                  <Phone size={15} aria-hidden className="shrink-0 text-[#555]" /> {phone}
                </a>
              </li>
            )}
            {site && (
              <li>
                <a href={site} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-[#242424] underline-offset-2 hover:underline break-all">
                  <Globe size={15} aria-hidden className="shrink-0 text-[#555]" /> {site.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
                </a>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
