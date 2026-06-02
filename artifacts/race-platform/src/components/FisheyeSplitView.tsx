import { useEffect, useRef } from "react";

interface FisheyeSplitViewProps {
  stream: MediaStream | null;
}

/**
 * Side-by-side canvas renderer for Insta360 X5 (and similar) dual-fisheye cameras.
 *
 * The camera outputs a stacked frame: front lens on the top half, back lens on the
 * bottom half. This component creates an internal off-screen <video> element (never
 * added to the DOM, never display:none), assigns the stream to it, and uses a canvas
 * to rearrange the two halves horizontally: front → left, back → right.
 *
 * Using an internal video element avoids the display:none decoding-suspension bug that
 * occurs when the caller hides its own <video> to make room for the canvas overlay.
 */
export function FisheyeSplitView({ stream }: FisheyeSplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");

    if (stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

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
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const ctx = canvas!.getContext("2d");
      if (!ctx) return;

      const srcW = video.videoWidth;
      const srcH = video.videoHeight;
      const halfSrcH = Math.floor(srcH / 2);
      const dstW = canvas!.width;
      const dstH = canvas!.height;
      const halfDstW = Math.floor(dstW / 2);

      ctx.drawImage(video, 0, 0, srcW, halfSrcH, 0, 0, halfDstW, dstH);
      ctx.drawImage(video, 0, halfSrcH, srcW, halfSrcH, halfDstW, 0, halfDstW, dstH);

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
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas ref={canvasRef} className="w-full block" style={{ maxHeight: "80vh" }} />
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
