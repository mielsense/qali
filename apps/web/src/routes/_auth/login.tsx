import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { svg as googleSvg } from "thesvg/google";

import { CalendarBackdrop } from "@/components/auth/calendar-backdrop";
import { authClient } from "@/lib/auth-client";
import { notify } from "@/lib/notices";

export const Route = createFileRoute("/_auth/login")({
  component: LoginComponent,
});

const googleIconSrc = `data:image/svg+xml,${encodeURIComponent(googleSvg)}`;

function GoogleIcon() {
  return (
    <img
      src={googleIconSrc}
      alt=""
      aria-hidden
      draggable={false}
      className="size-4"
    />
  );
}

function LoginComponent() {
  const [isLoading, setIsLoading] = useState(false);
  const reduceMotion = useReducedMotion();

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    await authClient.signIn.social(
      {
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/login",
      },
      {
        onError: () => {
          setIsLoading(false);
          notify({ kind: "sign-in-failed" });
        },
      },
    );
  };

  return (
    <div className="relative min-h-svh overflow-hidden bg-background">
      <CalendarBackdrop />

      <div className="relative z-10 flex min-h-svh items-center justify-center px-5 py-12">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 360, damping: 32 }}
          className="qali-surface qali-surface--floating w-full max-w-[380px] rounded-2xl p-1"
        >
          <div className="rounded-[14px] px-6 py-6">
            <div className="flex items-start gap-4">
              <span className="qali-control qali-control--raised flex size-12 shrink-0 items-center justify-center rounded-xl">
                <img
                  src="/icon.svg"
                  alt=""
                  aria-hidden="true"
                  className="size-8"
                />
              </span>
              <div className="min-w-0 pt-0.5">
                <h1 className="font-display text-xl leading-tight text-foreground">
                  Welcome to Qali
                </h1>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  Your calendar stays local. Connect Google to bring your
                  schedule into this Mac.
                </p>
              </div>
            </div>

            <div className="my-6 h-px bg-border" aria-hidden="true" />

            <div className="space-y-3">
              <Button
                variant="accent"
                size="lg"
                className="w-full rounded-lg"
                disabled={isLoading}
                aria-busy={isLoading}
                onClick={handleGoogleSignIn}
              >
                {isLoading ? <Spinner /> : <GoogleIcon />}
                {isLoading ? "Opening Google…" : "Continue with Google"}
              </Button>
              <p className="px-2 text-center text-[11px] leading-4 text-muted-foreground">
                Qali never sees your Google password. You can disconnect your
                account at any time in Settings.
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
