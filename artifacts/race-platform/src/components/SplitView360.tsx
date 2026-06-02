import { useEffect, useRef } from "react";

interface SplitView360Props {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Renders an Insta360 X5-style equirectangular stream (2880×1440, 2:1)
 * as two side-by-side square panels — front lens (left half) and back lens (right half).
 *
 * The video element itself stays hidden in the DOM so MediaSource keeps decoding.
 * This canvas reads each decoded frame and crops + draws the two halves.
 */
export function SplitView360({ videoRef }: SplitView360Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const video = videoRef.current;
    if (!canvas || !container || !video) return;

    // Resize canvas to match container width, maintaining 2:1 aspect
    const ro = new ResizeObserver(() => {
      const cw = container.clientWidth;
      if (cw > 0) {
        canvas.width = cw;
        canvas.height = Math.round(cw / 2);
      }
    });
    ro.observe(container);
    // Initial size
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

      const vw = vid.videoWidth;
      const vh = vid.videoHeight;
      const halfVw = Math.floor(vw / 2); // center split: x = vw/2 (e.g. 1440 for 2880px)

      const cw = canvas!.width;
      const ch = canvas!.height;
      const halfCw = Math.floor(cw / 2);

      // Front lens — left half of video frame → left half of canvas
      ctx.drawImage(vid, 0, 0, halfVw, vh, 0, 0, halfCw, ch);

      // Back lens — right half of video frame → right half of canvas
      ctx.drawImage(vid, halfVw, 0, halfVw, vh, halfCw, 0, halfCw, ch);

      // Center divider
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(halfCw, 0);
      ctx.lineTo(halfCw, ch);
      ctx.stroke();

      // Labels
      const labelH = Math.max(14, Math.round(ch * 0.035));
      ctx.font = `bold ${labelH}px sans-serif`;
      ctx.textBaseline = "top";
      const pad = Math.round(labelH * 0.5);

      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(pad - 2, pad - 2, ctx.measureText("FRONT").width + 8, labelH + 4);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText("FRONT", pad + 2, pad);

      const backLabel = "BACK";
      const backW = ctx.measureText(backLabel).width;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(halfCw + pad - 2, pad - 2, backW + 8, labelH + 4);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText(backLabel, halfCw + pad + 2, pad);
    }

    draw();

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, [videoRef]);

  return (
    <div ref={containerRef} className="w-full">
      <canvas
        ref={canvasRef}
        className="w-full block"
        style={{ maxHeight: "80vh", objectFit: "contain" }}
      />
    </div>
  );
}
