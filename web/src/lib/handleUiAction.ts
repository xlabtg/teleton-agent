export async function handleUiAction(
  action: () => Promise<unknown>,
  setError: (message: string) => void
): Promise<void> {
  try {
    await action();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}
