import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  capabilityEvidenceHash,
  loadCodexManifest,
  proxyPolicyHash,
  sha256File,
} from "../src/main/codex/manifest";
import { probeCodex } from "../src/main/codex/locator";
import { assertNoFileCredentials } from "../src/main/codex/auth";
import { capturePinnedCodexCapabilityEvidence } from "../src/main/codex/capability-verifier";
import { createCodexReleaseAuthority } from "../src/main/codex/boundary";
import {
  extractPinnedToolInventory,
  startFakeResponsesServer,
} from "./fixtures/fake-responses-server";

const resources = resolve(import.meta.dir, "../resources");

describe("real pinned Codex capability evidence", () => {
  test("fails closed when the pinned CLI capability gate is denied", async () => {
    const manifest = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
    const root = await mkdtemp(join(tmpdir(), "qali-codex-capability-"));
    const home = join(root, "home");
    const work = join(root, "work");
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const schema = join(root, "schema.json");
    await writeFile(schema, JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" } },
    }));
    const credentialCheck = () => assertNoFileCredentials(home, async () => true);
    let fixture: Awaited<ReturnType<typeof startFakeResponsesServer>> | undefined;
    try {
      if (manifest.capability.status === "blocked") {
        expect(manifest.capability.blockerCode).toBe("PINNED_CLI_CAPABILITY_GATE_DENIED");
        expect(manifest.capability.toolInventory).toEqual([]);
        expect(capabilityEvidenceHash([], manifest.capability.blockerCode, [])).toBe(manifest.capability.evidenceSha256);
        return;
      }
      expect(await probeCodex({
        manifest,
        manifestPath: join(resources, "codex-provider-manifest.json"),
        boundary: {
          codexHome: home,
          cwd: work,
          schemaPath: schema,
          sandboxProfilePath: join(resources, manifest.sandbox.path),
          proxyEndpoint: "localhost:43123",
        },
      })).toMatchObject({
        readiness: "blocked-by-policy",
        resolvedPath: manifest.executable.resolvedPath,
        reason: "PINNED_CLI_CAPABILITY_GATE_DENIED",
      });
      expect(await sha256File(join(resources, manifest.sandbox.path))).toBe(manifest.sandbox.sha256);
      expect(proxyPolicyHash(manifest.proxy.allowedHosts, manifest.proxy.allowedPorts)).toBe(manifest.proxy.policySha256);

      // Retained as the deterministic, credential-independent gate executed
      // only when the external-sandbox run is explicitly approved.
      fixture = await startFakeResponsesServer({
        allowedHosts: manifest.proxy.allowedHosts,
        allowedPorts: manifest.proxy.allowedPorts,
        expectedPolicySha256: manifest.proxy.policySha256,
        canaryRoot: root,
      });
      const authority = await createCodexReleaseAuthority({
        codexHome: home,
        cwd: work,
        schemaPath: schema,
        proxy: fixture.proxy,
        keyringHealthProbe: async () => { await credentialCheck(); return true; },
      });
      const capture = await capturePinnedCodexCapabilityEvidence({
        authority,
        timeoutMs: 20_000,
      });
      expect(capture.assessment).toMatchObject({ readiness: "ready" });
      expect(capture.evidence.toolInventory).toEqual(manifest.capability.toolInventory);
      expect(capture.evidence.evidenceSha256).toBe(manifest.capability.evidenceSha256);
      expect(await readFile(join(home, "auth.json"), "utf8").then(() => true).catch(() => false)).toBe(false);
    } finally {
      await fixture?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("callable capability release verifier", () => {
  test("inventories tools and additional_tools separately and rejects unknown declaration fields", () => {
    expect(extractPinnedToolInventory([{
      tools: [{ type: "function", name: "apply_patch" }],
      additional_tools: [{ type: "custom", name: "calendar_lookup" }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_tool_calls: null,
    }])).toEqual([
      "additional_tools:custom:calendar_lookup",
      "tools:function:apply_patch",
    ]);
    expect(() => extractPinnedToolInventory([{
      tools: [],
      future_tool_declarations: [{ type: "function", name: "hidden" }],
    }])).toThrow();
    expect(() => extractPinnedToolInventory([{
      additional_tools: [{ unexpected: "shape" }],
    }])).toThrow();
    expect(() => extractPinnedToolInventory([{
      tools: [{ type: "function", name: "unknown declaration name" }],
    }])).toThrow();
  });

  test("creates release authority only for the Qali-owned disposable provider", async () => {
    const manifest = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
    const root = await mkdtemp(join(tmpdir(), "qali-release-authority-"));
    const fixture = await startFakeResponsesServer({
      allowedHosts: manifest.proxy.allowedHosts,
      allowedPorts: manifest.proxy.allowedPorts,
      expectedPolicySha256: manifest.proxy.policySha256,
      canaryRoot: root,
    });
    try {
      expect(await createCodexReleaseAuthority({
        codexHome: "/tmp/qali-release-home",
        cwd: "/tmp/qali-release-work",
        schemaPath: "/tmp/qali-release-schema.json",
        proxy: fixture.proxy,
        keyringHealthProbe: async () => true,
      })).toMatchObject({ kind: "qali-codex-release-authority" });
      await expect(createCodexReleaseAuthority({
        codexHome: "/tmp/qali-release-home",
        cwd: "/tmp/qali-release-work",
        schemaPath: "/tmp/qali-release-schema.json",
        proxy: { ...fixture.proxy },
        keyringHealthProbe: async () => true,
      })).rejects.toMatchObject({ code: "CODEX_RELEASE_AUTHORITY_REQUIRED" });
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses only authority-owned capture, arming, and real canaries for release evidence", async () => {
    const blocked = await loadCodexManifest(join(resources, "codex-provider-manifest.json"));
    const root = await mkdtemp(join(tmpdir(), "qali-release-evidence-"));
    const fixture = await startFakeResponsesServer({
      allowedHosts: blocked.proxy.allowedHosts,
      allowedPorts: blocked.proxy.allowedPorts,
      expectedPolicySha256: blocked.proxy.policySha256,
      canaryRoot: root,
    });
    const denials = ["additional_tools:custom:calendar_lookup", "tools:local_shell"].map((tool) => ({
      tool,
      terminated: true,
      canaries: { fileIntact: true, processAbsent: true, networkUnreached: true },
    }));
    const evidenceSha256 = capabilityEvidenceHash(denials.map(({ tool }) => tool), undefined, denials);
    const phases: string[] = [];
    const response = await fetch(`${fixture.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qali-test-model",
        input: "planner inventory capture",
        tools: [{ type: "local_shell" }],
        additional_tools: [{ type: "custom", name: "calendar_lookup" }],
      }),
    });
    await response.text();
    const authority = await createCodexReleaseAuthority({
      codexHome: "/tmp/qali-release-home",
      cwd: "/tmp/qali-release-work",
      schemaPath: "/tmp/qali-release-schema.json",
      proxy: fixture.proxy,
      keyringHealthProbe: async () => true,
    });
    const capture = await capturePinnedCodexCapabilityEvidence({
      authority,
      timeoutMs: 1_000,
    }, {
      runPhase: async (request) => {
        phases.push(request.prompt);
        if (request.prompt.startsWith("Exercise the advertised ")) throw new (await import("../src/main/codex/auth")).CodexBoundaryError("CODEX_TOOL_ATTEMPT", "terminated");
        return { attemptId: request.attemptId, events: [], finalText: "{}" };
      },
    });
    expect(phases).toHaveLength(4);
    expect(capture.evidence).toEqual({
      toolInventory: ["additional_tools:custom:calendar_lookup", "tools:local_shell"],
      denials,
      evidenceSha256,
    });
    expect(capture.assessment).toMatchObject({ readiness: "blocked-by-policy" });
    await expect(capturePinnedCodexCapabilityEvidence({
      authority,
      timeoutMs: 1_000,
      provider: { inventory: () => [], armToolAttempt: async () => ({ prompt: "forged" }) },
      createCanary: async () => ({
        targets: { filePath: "", processExecutable: "", processMarkerPath: "", networkUrl: "" },
        verify: async () => ({ fileIntact: true, processAbsent: true, networkUnreached: true }),
        close: async () => {},
      }),
    } as never, { runPhase: async () => ({ attemptId: "forged", events: [], finalText: "{}" }) })).rejects.toMatchObject({
      code: "CODEX_RELEASE_AUTHORITY_REQUIRED",
    });
    await expect(capturePinnedCodexCapabilityEvidence({
      authority: { ...authority },
      timeoutMs: 1_000,
    } as never, { runPhase: async () => ({ attemptId: "copied", events: [], finalText: "{}" }) })).rejects.toMatchObject({
      code: "CODEX_RELEASE_AUTHORITY_REQUIRED",
    });
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
});
