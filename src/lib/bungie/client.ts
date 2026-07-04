import { RateLimiter } from '../utils/rate-limiter';
import { BungieEndpoints } from './endpoints';
import type {
    BungieResponse,
    DestinyProfileResponse,
    DestinyActivityHistoryResults,
    DestinyPostGameCarnageReportData,
    DestinyManifestResponse,
    DestinyExactPlayerSearchResponse,
    DestinyUserSearchResponse,
    DestinyLinkedProfilesResponse,
} from './types';

function getFetchTimeoutMs(): number {
    const parsed = parseInt(process.env.BUNGIE_FETCH_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

// ErrorCode 1672 (DestinyThrottledByGameServer) arrives as HTTP 503 with
// ThrottleSeconds: 0 — Bungie gives no duration, so we impose our own short
// pause instead of retrying into guaranteed 503s.
function getGameServerBackoffSec(): number {
    const parsed = parseInt(process.env.BUNGIE_GAME_SERVER_BACKOFF_SEC || '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

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

    constructor(apiKey: string, maxRequestsPerSecond: number = 25) {
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
            // A hung Bungie connection would otherwise stall a crawler/scanner worker
            // slot indefinitely. Callers already treat rejections as transient errors.
            signal: AbortSignal.timeout(getFetchTimeoutMs()),
        });

        if (!response.ok) {
            const text = await response.text();

            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('Retry-After') || '', 10);
                const pauseSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5;
                console.warn(`⚠️ HTTP 429 from Bungie — pausing key for ${pauseSec}s`);
                this.rateLimiter.pauseFor(pauseSec);
            } else {
                // Bungie error bodies are JSON even on 5xx; Cloudflare pages are not.
                try {
                    const body = JSON.parse(text) as Partial<BungieResponse<unknown>>;
                    if (body.ErrorCode === 1672) {
                        const pauseSec = Math.max(body.ThrottleSeconds || 0, getGameServerBackoffSec());
                        console.warn(`⚠️ Game server throttle (1672) — pausing key for ${pauseSec}s`);
                        this.rateLimiter.pauseFor(pauseSec);
                    }
                } catch {
                    // Non-JSON body (e.g. Cloudflare HTML) — nothing to inspect.
                }
            }

            throw new Error(`Bungie API error ${response.status}: ${text}`);
        }

        const data: BungieResponse<T> = await response.json();

        // Bungie-level throttling applies to the whole key, not just this
        // request — pause the shared limiter and fail fast; the ErrorCode
        // check below throws and callers treat it as a transient error.
        if (data.ThrottleSeconds > 0) {
            console.warn(`⚠️ Throttled by Bungie for ${data.ThrottleSeconds}s — pausing key`);
            this.rateLimiter.pauseFor(data.ThrottleSeconds);
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

    async getLinkedProfiles(
        membershipId: string,
        membershipType: number = -1
    ): Promise<BungieResponse<DestinyLinkedProfilesResponse>> {
        const url = BungieEndpoints.getLinkedProfiles(membershipId, membershipType);
        return this.request<DestinyLinkedProfilesResponse>(url);
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

    async getManifest(): Promise<BungieResponse<DestinyManifestResponse>> {
        const url = BungieEndpoints.getManifest();
        return this.request<DestinyManifestResponse>(url);
    }

    async searchDestinyPlayerByBungieName(
        displayName: string,
        displayNameCode: number,
        membershipType: number = -1
    ): Promise<BungieResponse<DestinyExactPlayerSearchResponse>> {
        const url = BungieEndpoints.searchDestinyPlayerByBungieName(membershipType);
        return this.request<DestinyExactPlayerSearchResponse>(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName, displayNameCode }),
        });
    }

    async searchByBungieNamePrefix(
        displayNamePrefix: string,
        page: number = 0
    ): Promise<BungieResponse<DestinyUserSearchResponse>> {
        const url = BungieEndpoints.searchByGlobalName(page);
        return this.request<DestinyUserSearchResponse>(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayNamePrefix }),
        });
    }

}

// Singleton instance
let clientInstance: BungieClient | null = null;
let discoveryClientInstance: BungieClient | null = null;

export function getBungieClient(): BungieClient {
    if (!clientInstance) {
        const apiKey = process.env.BUNGIE_API_KEY;
        if (!apiKey) throw new Error('BUNGIE_API_KEY not set in environment');

        const maxRps = parseInt(process.env.BUNGIE_MAX_REQUESTS_PER_SECOND || '25', 10);
        clientInstance = new BungieClient(apiKey, maxRps);
    }
    return clientInstance;
}

export function getDiscoveryBungieClient(): BungieClient {
    if (!discoveryClientInstance) {
        const apiKey = process.env.BUNGIE_DISCOVERY_API_KEY || process.env.BUNGIE_API_KEY;
        if (!apiKey) throw new Error('BUNGIE_DISCOVERY_API_KEY/BUNGIE_API_KEY not set in environment');

        const maxRps = parseInt(
            process.env.DISCOVERY_REQUESTS_PER_SECOND || process.env.BUNGIE_MAX_REQUESTS_PER_SECOND || '20',
            10
        );

        discoveryClientInstance = new BungieClient(apiKey, maxRps);
    }
    return discoveryClientInstance;
}
