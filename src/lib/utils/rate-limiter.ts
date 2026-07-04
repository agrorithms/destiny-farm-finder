export class RateLimiter {
    private nextSlot = 0; // earliest ms-epoch the next request may fire
    private tail: Promise<void> = Promise.resolve();
    private maxRequestsPerSecond: number;

    constructor(maxRequestsPerSecond: number) {
        this.maxRequestsPerSecond = maxRequestsPerSecond;
    }

    // Grants are serialized through a promise chain (FIFO), so two waiters can
    // never claim the same slot — concurrent callers can't burst past the RPS.
    wait(): Promise<void> {
        const grant = this.tail.then(async () => {
            while (true) {
                const now = Date.now();
                const at = Math.max(now, this.nextSlot);
                if (at > now) {
                    await new Promise((resolve) => setTimeout(resolve, at - now));
                    // Re-read nextSlot: a pauseFor() may have landed mid-sleep.
                    continue;
                }
                this.nextSlot = now + 1000 / this.maxRequestsPerSecond;
                return;
            }
        });
        // A rejected grant must not break the chain for later waiters.
        this.tail = grant.catch(() => {});
        return grant;
    }

    // Blocks all queued and future grants until the pause expires. Used when
    // Bungie signals throttling — the whole key must back off, not just the
    // request that saw the throttle response.
    pauseFor(seconds: number): void {
        this.nextSlot = Math.max(this.nextSlot, Date.now() + seconds * 1000);
    }
}
