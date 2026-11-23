import { lazy, Suspense, type ComponentProps } from "react";

// The 360° viewer needs three.js (~0.5 MB). Only 360° streams use it, so the
// watch page downloads it when one starts instead of with the page.
const SplitView360Impl = lazy(() =>
  import("./SplitView360").then((m) => ({ default: m.SplitView360 })),
);

export function SplitView360(props: ComponentProps<typeof SplitView360Impl>) {
  return (
    <Suspense fallback={null}>
      <SplitView360Impl {...props} />
    </Suspense>
  );
}
