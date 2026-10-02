import "./design/styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { LazyMotion, MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DeferredToaster } from "./components/ui/toaster";
import { installChunkRecovery } from "./lib/recovery";
import { queryClient, router } from "./router";

// A tab left open across a deploy reloads once to pick up the new build (R3-REL-14).
installChunkRecovery();

// Components use the lightweight `m` from motion/react; the animation features arrive in their own chunk.
// The import starts here, so it downloads in parallel with the first route chunk.
const motionFeatures = import("./design/motion-features").then((m) => m.default);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={() => motionFeatures}>
        <MotionConfig reducedMotion="user">
          <RouterProvider router={router} />
          <DeferredToaster />
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  </StrictMode>,
);
