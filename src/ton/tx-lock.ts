/**
 * Simple async mutex for TON wallet transactions.
 * Ensures the seqno read → sendTransfer sequence is atomic,
 * preventing two concurrent calls from getting the same seqno.
 */
let pending: Promise<void> = Promise.resolve();

const TX_LOCK_TIMEOUT_MS = 60_000;

export function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = (): { execute: Promise<T>; completion: Promise<void> } => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error("TON tx-lock timeout (60s)")),
        TX_LOCK_TIMEOUT_MS
      );
    });
    const operation = fn();
    const execute = Promise.race([operation, timeoutPromise]).finally(() => clearTimeout(timerId));
    const completion = operation.then(
      () => {},
      () => {}
    );
    return { execute, completion };
  };
  const turn = pending.then(guarded, guarded);
  const execute = turn.then(({ execute }) => execute);
  pending = turn.then(({ completion }) => completion);
  return execute;
}
