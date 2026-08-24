import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { env } from "@qali/env/web";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import ReactDOM from "react-dom/client";

import { authClient } from "@/lib/auth-client";
import { applyDesktopDocumentChrome, desktopApiFor } from "@/lib/desktop/api";
import { DesktopRendererProvider } from "@/lib/desktop/auth-provider";
import { HostedUserProvider } from "@/lib/desktop/status";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";
const convex = new ConvexReactClient(env.VITE_CONVEX_URL);
const desktopApi = desktopApiFor();
applyDesktopDocumentChrome(document.documentElement, desktopApi !== null);

function HostedRendererProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  return (
    <HostedUserProvider user={session?.user ?? null}>
      <ConvexBetterAuthProvider client={convex} authClient={authClient}>
        {children}
      </ConvexBetterAuthProvider>
    </HostedUserProvider>
  );
}

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <Loader />,
  context: {},
  Wrap: function WrapComponent({ children }: { children: React.ReactNode }) {
    if (desktopApi) {
      return (
        <DesktopRendererProvider api={desktopApi}>
          {children}
        </DesktopRendererProvider>
      );
    }
    return <HostedRendererProvider>{children}</HostedRendererProvider>;
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

// Mount immediately so the branded loading screen (ChromaLoader) paints right
// away instead of a blank #app. The loader shows its background at once and
// waits internally for Geist Pixel before revealing the "Q" — so nothing ever
// flashes a fallback serif, and there's no blank gap while fonts load.
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<RouterProvider router={router} />);
}
