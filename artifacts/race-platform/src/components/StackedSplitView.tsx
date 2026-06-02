import { useEffect, useRef } from "react";

interface StackedSplitViewProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Handles Insta360 X5 webcam mode output where the camera stacks both lenses
 * vertically into a single portrait frame (top = front lens, bottom = back lens).
 *
 * This canvas slices the frame at the horizontal midpoint and rearranges
 * the two halves side-by-side: front on the left, back on the right.
 * Output canvas is always 2:1 landscape regardless of source dimensions.
 */
export function StackedSplitView({ videoRef }: StackedSplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!container || !canvas || !video) return;

    // Size canvas to fill container at 2:1 (two square halves side by side)
    const ro = new ResizeObserver(() => {
      const cw = container.clientWidth;
      if (!cw) return;
      canvas.width = cw;
      canvas.height = Math.round(cw / 2);
    });
    ro.observe(container);
    const initW = container.clientWidth || 1280;
    canvas.width = initW;
    canvas.height = Math.round(initW / 2);

    let animId: number;

    function draw() {
      animId = requestAnimationFrame(draw);

      const vid = videoRef.current;
      if (!vid || vid.readyState < 2 || vid.videoWidth === 0) return;

      const ctx = canvas!.getContext("2d");
      if (!ctx) return;

      const srcW = vid.videoWidth;
      const srcH = vid.videoHeight;
      const halfSrcH = Math.floor(srcH / 2); // vertical midpoint of stacked frame

      const dstW = canvas!.width;
      const dstH = canvas!.height;
      const halfDstW = Math.floor(dstW / 2);

      // Front lens = top half of source → left half of canvas
      ctx.drawImage(vid, 0, 0, srcW, halfSrcH, 0, 0, halfDstW, dstH);

      // Back lens = bottom half of source → right half of canvas
      ctx.drawImage(vid, 0, halfSrcH, srcW, halfSrcH, halfDstW, 0, halfDstW, dstH);

      // Divider
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(halfDstW, 0);
      ctx.lineTo(halfDstW, dstH);
      ctx.stroke();
    }

    draw();

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, [videoRef]);

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas ref={canvasRef} className="w-full block" style={{ maxHeight: "80vh" }} />
      {/* Labels */}
      <div className="absolute inset-0 pointer-events-none select-none flex">
        <div className="flex-1 flex items-start p-2">
          <span className="bg-black/50 text-white/75 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded">
            Front
          </span>
        </div>
        <div className="w-px bg-white/20 self-stretch" />
        <div className="flex-1 flex items-start p-2">
          <span className="bg-black/50 text-white/75 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded">
            Back
          </span>
        </div>
      </div>
    </div>
  );
}
