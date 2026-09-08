export const AUTO_REFRESH_STALE_MS = 60_000;

export function dashboardNeedsRefresh(
  dashboard,
  nowMs = Date.now(),
  staleAfterMs = AUTO_REFRESH_STALE_MS,
) {
  const generatedAtMs = Date.parse(dashboard?.generatedAt ?? "");
  if (!Number.isFinite(generatedAtMs)) return true;
  return nowMs - generatedAtMs >= staleAfterMs;
}

export function createRangeRefreshGate() {
  const inFlight = new Map();

  return {
    run(range, refreshTask) {
      if (inFlight.has(range)) return inFlight.get(range);
      const request = Promise.resolve()
        .then(refreshTask)
        .finally(() => {
          if (inFlight.get(range) === request) inFlight.delete(range);
        });
      inFlight.set(range, request);
      return request;
    },
  };
}
