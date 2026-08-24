import { CodexBoundaryError } from "./auth";
import {
  resolveCodexReleaseAuthority,
  type CodexReleaseAuthority,
} from "./boundary";
import {
  assessCodexCapabilityEvidence,
  capabilityEvidenceHash,
  type CodexCapabilityAssessment,
  type CodexCapabilityDenial,
  type CodexCapabilityEvidence,
} from "./manifest";
import {
  runCodexReleasePhase,
  type CodexPhaseResult,
  type CodexReleasePhaseRequest,
} from "./process-driver";
export type {
  CodexCapabilityCanary,
  CodexCapabilityCanaryTargets,
} from "./egress-proxy";

export type CodexCapabilityVerifierDependencies = Readonly<{
  runPhase(request: CodexReleasePhaseRequest): Promise<CodexPhaseResult>;
}>;

export type CodexCapabilityCapture = Readonly<{
  evidence: CodexCapabilityEvidence;
  assessment: CodexCapabilityAssessment;
}>;

/**
 * Offline release verifier for the pinned real CLI. Each raw phase still goes
 * through runCodexReleasePhase, which verifies the exact committed binary,
 * profile, proxy policy, isolated auth state, and outer sandbox boundary. This
 * function never starts login and does not turn a blocked manifest ready.
 */
export async function capturePinnedCodexCapabilityEvidence(input: Readonly<{
  authority: CodexReleaseAuthority;
  timeoutMs: number;
}>, dependencies: CodexCapabilityVerifierDependencies = {
  runPhase: runCodexReleasePhase,
}): Promise<CodexCapabilityCapture> {
  if (
    !input || typeof input !== "object" ||
    Object.keys(input).sort().join(",") !== "authority,timeoutMs"
  ) {
    throw new CodexBoundaryError("CODEX_RELEASE_AUTHORITY_REQUIRED", "Only authority-owned capability controls are accepted");
  }
  const release = resolveCodexReleaseAuthority(input.authority);
  const phaseRequest = (
    phase: "planner" | "finalizer",
    attemptId: string,
    prompt: string,
  ): CodexReleasePhaseRequest => ({
    authority: input.authority,
    phase,
    attemptId,
    prompt,
    timeoutMs: input.timeoutMs,
    validateFinalOutput(text) { JSON.parse(text); },
  });

  for (const phase of ["planner", "finalizer"] as const) {
    await dependencies.runPhase(phaseRequest(
      phase,
      `capability-${phase}`,
      `Return {\"answer\":\"${phase}\"} and do not call tools.`,
    ));
  }

  const toolInventory = [...new Set(release.controls.inventory())].sort();
  const denials: CodexCapabilityDenial[] = [];
  for (const [index, tool] of toolInventory.entries()) {
    const canary = await release.controls.createCanary(tool);
    let terminated = false;
    try {
      const armed = await release.controls.armToolAttempt(tool, canary.targets);
      try {
        await dependencies.runPhase(
          phaseRequest("planner", `capability-tool-${index}`, armed.prompt),
        );
      } catch (error) {
        if (error instanceof CodexBoundaryError && error.code === "CODEX_TOOL_ATTEMPT") terminated = true;
        else throw error;
      }
      denials.push({ tool, terminated, canaries: await canary.verify() });
    } finally {
      await canary.close();
    }
  }
  const evidence: CodexCapabilityEvidence = {
    toolInventory,
    denials,
    evidenceSha256: capabilityEvidenceHash(toolInventory, undefined, denials),
  };
  return { evidence, assessment: assessCodexCapabilityEvidence(release.boundary.manifest, evidence) };
}
