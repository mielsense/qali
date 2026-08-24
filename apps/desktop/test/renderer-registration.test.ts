import { expect, test } from "bun:test";

import { createRendererIpcRegistry } from "../src/main/ipc/router";
import {
  handleRendererNavigationStarted,
  registerRendererDocument,
} from "../src/main/renderer-registration";

function fakeRenderer() {
  const mainFrame = {
    frameToken: "initial-document",
    parent: null,
    url: "qali-app://renderer/",
  };
  const sent: string[] = [];
  return {
    id: 1,
    mainFrame,
    send(channel: string) {
      sent.push(channel);
    },
    sent,
  };
}

function fakeReloadedRenderer() {
  const renderer = fakeRenderer();
  renderer.mainFrame.frameToken = "reloaded-document";
  return renderer;
}

test("authorizes initial bootstrap before releasing the renderer readiness signal", () => {
  const registry = createRendererIpcRegistry();
  const renderer = fakeRenderer();
  const event = { sender: renderer, senderFrame: renderer.mainFrame };

  expect(registry.authorize(event, "runtime:bootstrap")).toBe(false);

  registerRendererDocument(registry, renderer);

  expect(registry.authorize(event, "runtime:bootstrap")).toBe(true);
  expect(renderer.sent).toEqual(["desktop:ready"]);

  registerRendererDocument(registry, fakeReloadedRenderer());
  expect(registry.authorize(event, "runtime:bootstrap")).toBe(false);
});

test("keeps the current document authorized across in-place SPA navigation", () => {
  const registry = createRendererIpcRegistry();
  const renderer = fakeRenderer();
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  registerRendererDocument(registry, renderer);

  handleRendererNavigationStarted(registry, renderer.id, {
    isInPlace: true,
    isMainFrame: true,
  });

  expect(registry.authorize(event, "google:sync-all")).toBe(true);
});

test("revokes only when the main document is actually replaced", () => {
  const registry = createRendererIpcRegistry();
  const renderer = fakeRenderer();
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  registerRendererDocument(registry, renderer);

  handleRendererNavigationStarted(registry, renderer.id, {
    isInPlace: false,
    isMainFrame: false,
  });
  expect(registry.authorize(event, "google:sync-all")).toBe(true);

  handleRendererNavigationStarted(registry, renderer.id, {
    isInPlace: false,
    isMainFrame: true,
  });
  expect(registry.authorize(event, "google:sync-now")).toBe(false);
});
