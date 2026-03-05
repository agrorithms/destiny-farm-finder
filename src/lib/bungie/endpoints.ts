const BASE_URL = 'https://www.bungie.net/Platform';

export const BungieEndpoints = {
    getProfile: (membershipType: number, membershipId: string, components: number[]) =>
        `${BASE_URL}/Destiny2/${membershipType}/Profile/${membershipId}/?components=${components.join(',')}`,

    getActivityHistory: (
        membershipType: number,
        membershipId: string,
        characterId: string,
        params: { mode?: number; count?: number; page?: number }
    ) => {
        const query = new URLSearchParams();
        if (params.mode !== undefined) query.set('mode', String(params.mode));
        if (params.count !== undefined) query.set('count', String(params.count));
        if (params.page !== undefined) query.set('page', String(params.page));
        return `${BASE_URL}/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/Activities/?${query.toString()}`;
    },

    getPGCR: (activityId: string) =>
        `${BASE_URL}/Destiny2/Stats/PostGameCarnageReport/${activityId}/`,

    getManifest: () =>
        `${BASE_URL}/Destiny2/Manifest/`,

    searchPlayer: (membershipType: number, displayName: string) =>
        `${BASE_URL}/Destiny2/SearchDestinyPlayer/${membershipType}/${encodeURIComponent(displayName)}/`,

    searchByGlobalName: (displayName: string, page: number = 0) =>
        `${BASE_URL}/Destiny2/SearchDestinyPlayerByBungieName/${page}/`,
};
