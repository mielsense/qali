import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import type { RecoveryAuthority } from "./restore";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const id = z.string().min(1).max(256);
const optionalText = z.string().max(20_000).optional();
const attendee = z.object({
  email: z.string().email().max(320),
  displayName: z.string().max(512).optional(),
  responseStatus: z.string().max(64).optional(),
}).strip();
const snapshotSchema = z.object({
  calendars: z.array(z.object({
    id,
    name: z.string().max(512).optional(),
    color: z.string().max(128).optional(),
    timeZone: z.string().max(128).optional(),
    selected: z.boolean().optional(),
  }).strip()).max(500),
  events: z.array(z.object({
    id,
    calendarId: id,
    title: z.string().max(20_000).optional(),
    description: optionalText,
    location: z.string().max(4_096).optional(),
    startMs: z.number().finite(),
    endMs: z.number().finite(),
    allDay: z.boolean().optional(),
    timeZone: z.string().max(128).optional(),
    recurrence: z.array(z.string().max(4_096)).max(256).optional(),
    attendees: z.array(attendee).max(2_000).optional(),
  }).strip()).max(100_000),
  pendingOperations: z.array(z.object({
    id,
    kind: z.enum(["create", "update", "move", "respond", "delete"]),
    state: z.enum(["pending", "in-flight", "ambiguous", "failed", "succeeded"]),
  }).strip()).max(20_000),
}).strip();

export type LocalDataExportResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "exported"; bytes: number; calendarCount: number; eventCount: number }>;

export async function exportLocalData(input: Readonly<{
  authority: RecoveryAuthority;
  chooseDestination(): Promise<string | null>;
  loadSnapshot(): Promise<unknown>;
  now?: Date;
}>): Promise<LocalDataExportResult> {
  // Touch the already-validated authority so this operation cannot be called
  // with a destination-only filesystem primitive.
  await lstat(input.authority.root);
  const destination = await input.chooseDestination();
  if (destination === null) return { kind: "cancelled" };
  if (!destination || destination.includes("\0")) throw new Error("INVALID_EXPORT_DESTINATION");
  await lstat(dirname(destination)).then((metadata) => {
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("INVALID_EXPORT_DESTINATION");
    }
  });
  const snapshot = snapshotSchema.parse(await input.loadSnapshot());
  const document = {
    formatVersion: 1,
    exportedAt: (input.now ?? new Date()).toISOString(),
    calendars: snapshot.calendars,
    events: snapshot.events,
    pendingOperations: snapshot.pendingOperations,
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new Error("EXPORT_TOO_LARGE");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    bytes.fill(0);
  }
  return {
    kind: "exported",
    bytes: bytes.byteLength,
    calendarCount: snapshot.calendars.length,
    eventCount: snapshot.events.length,
  };
}
