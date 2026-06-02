import { useEffect, useRef } from "react";
import * as THREE from "three";

interface SplitView360Props {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Renders an equirectangular 360° stream (e.g. Insta360 X5 at 2880×1440)
 * as two de-warped flat views side-by-side using Three.js.
 *
 * The equirectangular frame is mapped onto the inside of a sphere.
 * Two PerspectiveCamera instances — one facing forward (0°) and one facing
 * backward (180°) — are rendered into left and right viewport halves.
 * This correctly undoes the fisheye projection so each pane looks like a
 * natural flat wide-angle view instead of a warped crop.
 */
export function SplitView360({ videoRef }: SplitView360Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;

    const initW = container.clientWidth || 1280;
    const initH = Math.round(initW / 2);

    // ── Renderer ────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(initW, initH);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.autoClear = false;
    container.appendChild(renderer.domElement);

    // ── Scene: sphere with equirectangular video texture ────────────────────
    const scene = new THREE.Scene();
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;

    const geometry = new THREE.SphereGeometry(500, 64, 32);
    geometry.scale(-1, 1, 1); // invert so the texture faces inward

    const material = new THREE.MeshBasicMaterial({ map: texture });
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    // ── Two cameras: front (0°) and back (180°) ──────────────────────────
    const halfAspect = (initW / 2) / initH;

    // Front camera — looking into the sphere at yaw=0
    const frontCam = new THREE.PerspectiveCamera(85, halfAspect, 1, 1000);
    frontCam.position.set(0, 0, 0);
    // No rotation needed — default look direction is +Z which maps to lon=0

    // Back camera — looking in the opposite direction (yaw=180°)
    const backCam = new THREE.PerspectiveCamera(85, halfAspect, 1, 1000);
    backCam.position.set(0, 0, 0);
    backCam.rotation.set(0, Math.PI, 0);

    // ── Resize observer ──────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      const nw = container.clientWidth;
      if (!nw) return;
      const nh = Math.round(nw / 2);
      renderer.setSize(nw, nh);

      const newAspect = (nw / 2) / nh;
      frontCam.aspect = newAspect;
      frontCam.updateProjectionMatrix();
      backCam.aspect = newAspect;
      backCam.updateProjectionMatrix();
    });
    ro.observe(container);

    // ── Render loop ──────────────────────────────────────────────────────────
    let animId: number;
    function animate() {
      animId = requestAnimationFrame(animate);
      texture.needsUpdate = true;

      // Use the actual pixel dimensions of the canvas (accounts for devicePixelRatio)
      const cw = renderer.domElement.width;
      const ch = renderer.domElement.height;
      const halfW = Math.floor(cw / 2);

      renderer.clear();

      // Left half → front camera
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, halfW, ch);
      renderer.setScissor(0, 0, halfW, ch);
      renderer.render(scene, frontCam);

      // Right half → back camera
      renderer.setViewport(halfW, 0, cw - halfW, ch);
      renderer.setScissor(halfW, 0, cw - halfW, ch);
      renderer.render(scene, backCam);
    }
    animate();

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [videoRef]);

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      style={{ aspectRatio: "2 / 1" }}
    >
      {/* Labels rendered as HTML overlay so they don't cost a WebGL draw call */}
      <div className="absolute inset-0 pointer-events-none select-none flex">
        <div className="flex-1 flex items-start justify-start p-2">
          <span className="bg-black/50 text-white/75 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded">
            Front
          </span>
        </div>
        <div className="w-px bg-white/20 self-stretch" />
        <div className="flex-1 flex items-start justify-start p-2">
          <span className="bg-black/50 text-white/75 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded">
            Back
          </span>
        </div>
      </div>
    </div>
  );
}
