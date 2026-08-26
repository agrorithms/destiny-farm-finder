import type { Route } from '@playwright/test';
import { bungieEnvelope, type BungieEnvelopeOverrides } from '../../tests/helpers/bungie-profile-builder';

/**
 * Answers one intercepted Bungie call with a platform envelope.
 *
 * The status/contentType/JSON.stringify triple is identical at every stub site
 * across the client-write specs; only the payload differs. Keeping it here means
 * a spec's route handler reads as the branching logic it actually is.
 */
export function fulfillBungie(
    route: Route,
    response: unknown,
    overrides: BungieEnvelopeOverrides = {}
): Promise<void> {
    return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(bungieEnvelope(response, overrides)),
    });
}
