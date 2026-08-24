// @ts-expect-error Bun supplies its test module at runtime.
import { afterAll, describe, expect, test } from "bun:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let oscillatorStarts = 0;

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  state = "running";

  createGain() {
    return {
      connect() {},
      gain: {
        exponentialRampToValueAtTime() {},
        setValueAtTime() {},
      },
    };
  }

  createOscillator() {
    return {
      connect() {},
      frequency: {
        exponentialRampToValueAtTime() {},
        setValueAtTime() {},
      },
      start() {
        oscillatorStarts += 1;
      },
      stop() {},
      type: "sine",
    };
  }

  resume() {
    return Promise.resolve();
  }
}

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    AudioContext: FakeAudioContext,
    addEventListener() {},
    removeEventListener() {},
  },
});

const sound = await import("./sound");

afterAll(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("global interface sound gate", () => {
  test("stops every shared interface sound immediately while disabled", () => {
    sound.setInterfaceSoundsEnabled(false);
    sound.playHoverSound();
    sound.playClickSound();
    sound.playTickSound();
    sound.playBounceSound();
    expect(oscillatorStarts).toBe(0);

    sound.setInterfaceSoundsEnabled(true);
    sound.playHoverSound();
    sound.playClickSound();
    sound.playTickSound();
    sound.playBounceSound();
    expect(oscillatorStarts).toBe(5);
  });
});
