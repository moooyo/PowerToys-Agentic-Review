export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Operation aborted."));
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Operation aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForPromisesWithTimeout(
  promises: readonly Promise<unknown>[],
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (promises.length === 0) {
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMilliseconds);
    timer.unref();
  });
  const completed = Promise.allSettled(promises).then(() => true as const);
  const result = await Promise.race([completed, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}
