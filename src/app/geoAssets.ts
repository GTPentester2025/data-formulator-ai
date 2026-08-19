// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Keeps chart rendering fully local.
//
// flint-chart's map templates point their topojson basemaps at
// https://vega.github.io/vega-lite/data/*.json, so rendering a US/World map
// made the browser fetch from a third-party host. Those two files are now
// vendored under `public/geo/` and every assembled spec is rewritten to load
// them from this app's own origin.
//
// Any *other* remote `url` in a chart spec is stripped rather than fetched:
// all legitimate chart data reaches the spec inline (`data.values`) from the
// local backend, so a remote URL in a spec is either this basemap case or
// something we do not want the browser reaching out to.

/** Vendored basemaps, keyed by the upstream URL they replace. */
const GEO_URL_MAP: Record<string, string> = {
    'https://vega.github.io/vega-lite/data/us-10m.json': '/geo/us-10m.json',
    'https://vega.github.io/vega-lite/data/world-110m.json': '/geo/world-110m.json',
};

const isRemoteUrl = (url: string) => /^(https?:)?\/\//i.test(url.trim());

/**
 * Rewrite vendored basemap URLs to local paths and strip any other remote
 * URL, in place, anywhere in `spec`. Returns the same object for chaining.
 */
export const localizeGeoUrls = <T,>(spec: T): T => {
    const visit = (node: any) => {
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (!node || typeof node !== 'object') return;

        if (typeof node.url === 'string') {
            const local = GEO_URL_MAP[node.url.trim()];
            if (local) {
                node.url = local;
            } else if (isRemoteUrl(node.url)) {
                console.warn('localizeGeoUrls: stripped remote data url from chart spec', node.url);
                delete node.url;
                delete node.format;
                node.values = [];
            }
        }

        for (const value of Object.values(node)) {
            visit(value);
        }
    };

    visit(spec);
    return spec;
};
