import { useEffect, useRef } from "react";
import * as THREE from "three";

interface Viewer360Props {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export function Viewer360({ videoRef }: Viewer360Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, w / h, 0.1, 1100);
    camera.position.set(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const geometry = new THREE.SphereGeometry(500, 60, 40);
    geometry.scale(-1, 1, 1);

    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({ map: texture });
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    let lon = 0;
    let lat = 0;
    let isPointerDown = false;
    let lastX = 0;
    let lastY = 0;

    function updateCamera() {
      const clampedLat = Math.max(-85, Math.min(85, lat));
      const phi = THREE.MathUtils.degToRad(90 - clampedLat);
      const theta = THREE.MathUtils.degToRad(lon);
      camera.lookAt(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta),
      );
    }

    const onMouseDown = (e: MouseEvent) => {
      isPointerDown = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isPointerDown) return;
      lon -= (e.clientX - lastX) * 0.25;
      lat -= (e.clientY - lastY) * 0.25;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMouseUp = () => { isPointerDown = false; };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      isPointerDown = true;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!isPointerDown || e.touches.length < 1) return;
      lon -= (e.touches[0].clientX - lastX) * 0.35;
      lat -= (e.touches[0].clientY - lastY) * 0.35;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    };
    const onTouchEnd = () => { isPointerDown = false; };

    let gyroActive = false;
    let alphaOffset = 0;
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (isPointerDown || e.alpha === null || e.beta === null) return;
      if (!gyroActive) { alphaOffset = e.alpha!; gyroActive = true; }
      lon = -(e.alpha! - alphaOffset);
      lat = (e.beta ?? 0) - 90;
    };
    window.addEventListener("deviceorientation", onOrientation as EventListener);

    renderer.domElement.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: false });
    renderer.domElement.addEventListener("touchmove", onTouchMove, { passive: false });
    renderer.domElement.addEventListener("touchend", onTouchEnd);

    const resizeObserver = new ResizeObserver(() => {
      const nw = container.clientWidth;
      const nh = container.clientHeight;
      if (nw === 0 || nh === 0) return;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    });
    resizeObserver.observe(container);

    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      texture.needsUpdate = true;
      updateCamera();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("touchmove", onTouchMove);
      renderer.domElement.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("deviceorientation", onOrientation as EventListener);
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
      className="absolute inset-0 cursor-grab active:cursor-grabbing select-none"
      style={{ touchAction: "none" }}
    />
  );
}
