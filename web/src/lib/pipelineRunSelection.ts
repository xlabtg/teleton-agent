export function selectRunIdToLoad(
  selectedRunId: string | null,
  runIds: readonly string[]
): string | null {
  if (runIds.length === 0) return null;
  if (selectedRunId && runIds.includes(selectedRunId)) return selectedRunId;
  return runIds[0] ?? null;
}
