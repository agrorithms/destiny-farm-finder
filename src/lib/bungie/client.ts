import { RateLimiter } from '../utils/rate-limiter';
import { BungieEndpoints } from './endpoints';
import type {
    BungieResponse,
    DestinyProfileResponse,
    DestinyActivityHistoryResults,
    DestinyPostGameCarnageReportData,
} from './types';

export class BungieAPIError extends Error {
    public errorCode: number;
    public errorStatus: string;

    constructor(errorCode: number, errorStatus: string, message: string) {
        super(message);
        this.name = 'BungieAPIError';
        this.errorCode = errorCode;
        this.errorStatus = errorStatus;
    }
}

export class BungieClient {
    private apiKey: string;
    private rateLimiter: RateLimiter;

    constructor(apiKey: string, maxRequestsPerSecond: number = 20) {
        this.apiKey = apiKey;
        this.rateLimiter = new RateLimiter(maxRequestsPerSecond);
    }

    private async request<T>(url: string, options?: RequestInit): Promise<BungieResponse<T>> {
        await this.rateLimiter.wait();

        const response = await fetch(url, {
            ...options,
            headers: {
                'X-API-Key': this.apiKey,
                ...options?.headers,
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Bungie API error ${response.status}: ${text}`);
        }

        const data: BungieResponse<T> = await response.json();

        // Handle Bungie-level throttling
        if (data.ThrottleSeconds > 0) {
            console.warn(`⚠️ Throttled by Bungie for ${data.ThrottleSeconds}s`);
            await new Promise((resolve) => setTimeout(resolve, data.ThrottleSeconds * 1000));
        }

        if (data.ErrorCode !== 1) {
            throw new BungieAPIError(
                data.ErrorCode,
                data.ErrorStatus,
                data.Message
            );
        }

        return data;
    }

    async getProfile(
        membershipType: number,
        membershipId: string,
        components: number[]
    ): Promise<BungieResponse<DestinyProfileResponse>> {
        const url = BungieEndpoints.getProfile(membershipType, membershipId, components);
        return this.request<DestinyProfileResponse>(url);
    }

    async getActivityHistory(
        membershipType: number,
        membershipId: string,
        characterId: string,
        params: { mode?: number; count?: number; page?: number } = {}
    ): Promise<BungieResponse<DestinyActivityHistoryResults>> {
        const url = BungieEndpoints.getActivityHistory(
            membershipType,
            membershipId,
            characterId,
            params
        );
        return this.request<DestinyActivityHistoryResults>(url);
    }

    async getPGCR(
        activityId: string
    ): Promise<BungieResponse<DestinyPostGameCarnageReportData>> {
        const url = BungieEndpoints.getPGCR(activityId);
        return this.request<DestinyPostGameCarnageReportData>(url);
    }

    async getManifest(): Promise<BungieResponse<any>> {
        const url = BungieEndpoints.getManifest();
        return this.request<any>(url);
    }

    async searchByGlobalName(
        displayName: string,
        displayNameCode: number
    ): Promise<BungieResponse<any>> {
        const url = BungieEndpoints.searchByGlobalName(displayName);
        return this.request<any>(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName, displayNameCode }),
        });
    }

    getRateLimiterStatus(): number {
        return this.rateLimiter.getAvailableTokens();
    }
}

// Singleton instance
let clientInstance: BungieClient | null = null;

export function getBungieClient(): BungieClient {
    if (!clientInstance) {
        const apiKey = process.env.BUNGIE_API_KEY;
        if (!apiKey) throw new Error('BUNGIE_API_KEY not set in environment');

        const maxRps = parseInt(process.env.BUNGIE_MAX_REQUESTS_PER_SECOND || '20', 10);
        clientInstance = new BungieClient(apiKey, maxRps);
    }
    return clientInstance;
}
