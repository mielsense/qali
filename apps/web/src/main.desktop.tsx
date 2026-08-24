import { RouterProvider, createRouter } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import Loader from "./components/loader";
import {
  applyDesktopDocumentChrome,
  desktopApiFor,
} from "./lib/desktop/api";
import { DesktopRendererProvider } from "./lib/desktop/auth-provider";
import { desktopRouteTree } from "./routeTree.desktop";

const desktopApi = desktopApiFor();
if (!desktopApi) throw new Error("Qali desktop bridge is unavailable");
applyDesktopDocumentChrome(document.documentElement, true);

const router = createRouter({
  routeTree: desktopRouteTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <Loader />,
  context: {},
  Wrap: ({ children }) => (
    <DesktopRendererProvider api={desktopApi}>{children}</DesktopRendererProvider>
  ),
});

const rootElement = document.getElementById("app");
if (!rootElement) throw new Error("Root element not found");
if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />);
}
