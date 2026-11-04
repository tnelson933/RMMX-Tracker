/**
 * Racer profile photos on the rider website (same as the app): a headshot in
 * place of the initials circle and a background photo in place of the stock
 * riding photo. Photos are shrunk in the browser before upload.
 */
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, ImageIcon, Loader2, Trash2 } from "lucide-react";

import { riderApi, type PhotoKind } from "@/lib/rider-api";
import { STOCK_PHOTO } from "./insights";

export function initialsOf(name: string): string {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

/** Round headshot, or the rider's initials when there's no photo to show. */
export function RiderAvatar({ url, name, size = 40, className = "" }: { url?: string | null; name: string; size?: number; className?: string }) {
  if (url) {
    return <img src={url} alt={`Photo of ${name}`} width={size} height={size}
      className={`shrink-0 rounded-full object-cover ${className}`} style={{ width: size, height: size }} />;
  }
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[#3A3A3A] font-heading font-extrabold text-white ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.34 }}>
      {initialsOf(name)}
    </span>
  );
}

const MAX_WIDTH: Record<PhotoKind, number> = { avatar: 600, cover: 1600 };

/** JPEG no wider than the kind's limit; the headshot is cropped to a centred square. */
async function shrink(file: File, kind: PhotoKind): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // The server checks the type; let it explain.
  }
  let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
  if (kind === "avatar") {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
  }
  const scale = Math.min(1, MAX_WIDTH[kind] / sw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
  canvas.getContext("2d")!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve) => canvas.toBlob(b => resolve(b ?? file), "image/jpeg", 0.85));
}

export function RacerPhotosEditor({ riderId, name, avatarUrl, coverUrl }: {
  riderId: number; name: string; avatarUrl: string | null; coverUrl: string | null;
}) {
  const qc = useQueryClient();
  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    setError(null);
    qc.invalidateQueries({ queryKey: ["rider-profile-detail", riderId] });
    qc.invalidateQueries({ queryKey: ["rider-profiles"] });
    qc.invalidateQueries({ queryKey: ["rider-card", riderId] });
    qc.invalidateQueries({ queryKey: ["racer", riderId] });
  };
  const upload = useMutation({
    mutationFn: async ({ kind, file }: { kind: PhotoKind; file: File }) => riderApi.uploadPhoto(riderId, kind, await shrink(file, kind)),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (kind: PhotoKind) => riderApi.removePhoto(riderId, kind),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });
  const busyKind = upload.isPending ? upload.variables?.kind : remove.isPending ? remove.variables : null;
  const busy = busyKind != null;

  const label = "font-heading font-bold uppercase tracking-[1.1px] text-[13px] text-[#707070]";
  const btn = "inline-flex items-center gap-1.5 rounded-full border-2 border-[#D0D0D0] px-3 py-1.5 text-[14px] font-semibold text-[#242424] hover:border-[#242424] disabled:opacity-50";

  const picker = (kind: PhotoKind, ref: React.RefObject<HTMLInputElement | null>) => (
    <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden
      onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload.mutate({ kind, file: f }); }} />
  );
  const actions = (kind: PhotoKind, has: boolean, ref: React.RefObject<HTMLInputElement | null>) => {
    const what = kind === "avatar" ? "profile photo" : "background photo";
    return (
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy} onClick={() => ref.current?.click()} aria-label={`Choose a ${what}`}>
          <ImageIcon size={15} /> Choose
        </button>
        {has && (
          <button type="button" className={btn} disabled={busy} onClick={() => remove.mutate(kind)} aria-label={`Remove the ${what}`}>
            <Trash2 size={15} /> Remove
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className={label}>Profile photo</div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <RiderAvatar url={avatarUrl} name={name} size={72} />
            {busyKind === "avatar" && <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45"><Loader2 className="animate-spin text-white" size={22} /></span>}
          </div>
          {actions("avatar", !!avatarUrl, avatarInput)}
          {picker("avatar", avatarInput)}
        </div>
      </div>

      <div className="space-y-2">
        <div className={label}>Background photo</div>
        <div className="relative h-32 overflow-hidden rounded-lg bg-[#161616]">
          <img src={coverUrl || STOCK_PHOTO} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover object-[50%_20%]" />
          <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-black/0 to-black/70" />
          <span className="absolute bottom-2 left-3 text-[13px] font-medium text-white">
            {coverUrl ? "Your background photo" : "Stock photo (shown until you add your own)"}
          </span>
          {busyKind === "cover" && <span className="absolute inset-0 flex items-center justify-center bg-black/45"><Loader2 className="animate-spin text-white" size={24} /></span>}
        </div>
        {actions("cover", !!coverUrl, coverInput)}
        {picker("cover", coverInput)}
      </div>

      <p className="flex items-start gap-1.5 text-[13px] text-[#707070]">
        <Camera size={14} className="mt-0.5 shrink-0" />
        JPEG, PNG or WebP, up to 8 MB. Photos follow the same setting as the bio: on a private profile only you and the profile's managers see them.
      </p>
      {error && <p role="alert" className="text-[14px] font-medium text-[#C62828]">{error}</p>}
    </div>
  );
}
