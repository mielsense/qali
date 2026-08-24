export type FakeCodexScenario =
  | { kind: "jsonl"; lines: readonly string[]; exitCode?: number }
  | { kind: "malformed"; bytes: string }
  | { kind: "crash"; exitCode: number }
  | { kind: "hang" };

export function fakeCodexJsonl(...events: readonly unknown[]): FakeCodexScenario {
  return { kind: "jsonl", lines: events.map((event) => JSON.stringify(event)), exitCode: 0 };
}

export function fakeCodexToolAttempt(type: string): FakeCodexScenario {
  return fakeCodexJsonl({ type: "item.started", item: { type } });
}
