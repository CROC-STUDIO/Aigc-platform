function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function backoffMs(attemptIndex, initialBackoffMs, maxBackoffMs) {
  const base = Math.max(0, Number(initialBackoffMs) || 0);
  const max = Math.max(base, Number(maxBackoffMs) || base);
  return Math.min(max, base * (2 ** Math.max(0, attemptIndex)));
}

function normalizeFallbackChain(fallbackChain) {
  return Array.isArray(fallbackChain)
    ? fallbackChain.filter((item) => item && typeof item === "object" && item.mode)
    : [];
}

export async function invokeLlmWithRetry({
  call,
  isRetryable = () => false,
  onRetry,
  onFallback,
  maxRetries = 3,
  initialBackoffMs = 1000,
  maxBackoffMs = 8000,
  retryTimeoutCapMs,
  fallbackChain
} = {}) {
  if (typeof call !== "function") {
    throw new TypeError("invokeLlmWithRetry requires a call function");
  }
  const chain = normalizeFallbackChain(fallbackChain);
  let fallbackIndex = 0;
  let lastError;
  let attempt = 1;
  const maxAttemptCount = Math.max(1, Math.trunc(Number(maxRetries) || 0) + 1);

  while (attempt <= maxAttemptCount) {
    const activeFallback = chain[fallbackIndex] || {};
    try {
      return await call(attempt, {
        mode: activeFallback.mode,
        fallbackIndex,
        timeoutCapMs: attempt > 1 ? retryTimeoutCapMs : undefined,
        lastError
      });
    } catch (error) {
      lastError = error;
      const nextFallback = chain[fallbackIndex + 1];
      if (
        nextFallback
        && typeof activeFallback.isFallbackNeededError === "function"
        && activeFallback.isFallbackNeededError(error)
      ) {
        await onFallback?.(activeFallback.mode, nextFallback.mode, error);
        fallbackIndex += 1;
        continue;
      }

      const retryDecision = await isRetryable(error);
      if (retryDecision === "fallback") {
        continue;
      }
      if (attempt >= maxAttemptCount || !retryDecision) {
        throw error;
      }
      await onRetry?.(attempt, {
        maxRetries,
        timeoutCapMs: retryTimeoutCapMs,
        mode: activeFallback.mode,
        error
      });
      await delayMs(backoffMs(attempt - 1, initialBackoffMs, maxBackoffMs));
      attempt += 1;
    }
  }
  throw lastError;
}
