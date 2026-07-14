export function formatApprovalParams(params: string): string {
  try {
    return JSON.stringify(JSON.parse(params));
  } catch {
    return params;
  }
}
