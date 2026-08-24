export type SubmissionLatch = { current: boolean };

/** React state remains the visible loading state, while this synchronous latch
 * closes the window in which two submit events can arrive before React commits
 * that state update. */
export function claimEventCreateSubmission(latch: SubmissionLatch): boolean {
  if (latch.current) return false;
  latch.current = true;
  return true;
}
