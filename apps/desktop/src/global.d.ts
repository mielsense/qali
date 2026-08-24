import type { QaliDesktopApi } from "@qali/desktop-contracts";

declare module "original-fs" {
  export { readFileSync } from "node:fs";
}

declare global {
  interface Window {
    qali: QaliDesktopApi;
  }
}

export {};
