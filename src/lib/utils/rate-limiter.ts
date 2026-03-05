export class RateLimiter {
    private tokens: number;
    private maxTokens: number;
    private refillRate: number; // tokens per ms
    private lastRefill: number;

    constructor(maxRequestsPerSecond: number) {
        this.maxTokens = maxRequestsPerSecond;
        this.tokens = maxRequestsPerSecond;
        this.refillRate = maxRequestsPerSecond / 1000;
        this.lastRefill = Date.now();
    }

    private refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }

    async wait(): Promise<void> {
        this.refill();

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }

        // Calculate wait time until we have a token
        const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.refill();
        this.tokens -= 1;
    }

    getAvailableTokens(): number {
        this.refill();
        return Math.floor(this.tokens);
    }
}
