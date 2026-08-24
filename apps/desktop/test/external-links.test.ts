import { describe, expect, test } from "bun:test";

import {
  isAllowedExternalProductUrl,
  isAllowedAssistantLoginUrl,
  trustedExternalLinkFromClick,
} from "../src/main/external-links";

describe("external product links", () => {
  test("rejects scripted or untrusted activation", () => {
    expect(
      trustedExternalLinkFromClick(false, "https://calendar.google.com/calendar/render"),
    ).toBeNull();
  });

  test("rejects non-allowlisted and non-HTTPS product URLs", () => {
    expect(isAllowedExternalProductUrl("https://evil.example/calendar")).toBe(false);
    expect(isAllowedExternalProductUrl("http://calendar.google.com/calendar/render")).toBe(false);
  });

  test("accepts explicitly required product hosts over HTTPS", () => {
    expect(
      isAllowedExternalProductUrl("https://calendar.google.com/calendar/render"),
    ).toBe(true);
  });

  test("assistant login permits only the exact verified OpenAI auth origin", () => {
    expect(isAllowedAssistantLoginUrl("https://auth.openai.com/device")).toBe(true);
    expect(isAllowedAssistantLoginUrl("https://auth.openai.com.evil.test/device")).toBe(false);
    expect(isAllowedAssistantLoginUrl("https://auth.openai.com:444/device")).toBe(false);
  });
});
