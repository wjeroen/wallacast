// The process's own memory in the logs. Railway's graph shows only the total (rss), which
// cannot tell a leak from memory Node keeps for reuse after a peak: a heap that keeps growing
// across hours is a leak, an rss that stays high while the heap falls back is not. The
// backend grew from 300 MB to 2.1 GB in ten days before the parser leak was found
// (2026-10-18, see html-parser.ts).

const mb = (bytes: number) => Math.round(bytes / 1e6);

export function logMemory(when: string): void {
  const m = process.memoryUsage();
  console.log(
    `[Memory] ${when}: rss ${mb(m.rss)} MB, heap used ${mb(m.heapUsed)} of ${mb(m.heapTotal)} MB, ` +
    `external ${mb(m.external)} MB, array buffers ${mb(m.arrayBuffers)} MB`
  );
}

// Once an hour for the life of the process. unref() lets the process exit without waiting.
export function startHourlyMemoryLog(): void {
  setInterval(() => logMemory('hourly'), 60 * 60 * 1000).unref();
}
