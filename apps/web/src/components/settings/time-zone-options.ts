export function timeZoneLabel(zone: string): string {
  return zone.replaceAll("_", " ");
}

export function searchTimeZones(
  zones: readonly string[],
  query: string,
): readonly string[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return zones;
  return zones.filter((zone) =>
    timeZoneLabel(zone).toLocaleLowerCase().includes(normalized),
  );
}

export function updateReferenceTimeZones(
  current: readonly string[],
  index: number,
  next: string,
  primary: string,
): readonly string[] {
  const updated = [...current];
  if (next && next !== primary) updated[index] = next;
  else updated.splice(index, 1);
  return [...new Set(updated.filter((zone) => zone !== primary))].slice(0, 2);
}

export function resolveTimeZoneSelection(
  next: string | null,
  optional: boolean,
): string | undefined {
  if (next !== null) return next;
  return optional ? "" : undefined;
}
