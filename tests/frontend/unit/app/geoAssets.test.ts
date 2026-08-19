/**
 * Chart specs must never send the browser to a third-party host.
 *
 * flint-chart's map templates embed vega.github.io basemap URLs; those files
 * are vendored under public/geo and rewritten to this origin. Any other remote
 * URL in a spec is stripped rather than fetched.
 */
import { describe, it, expect, vi } from "vitest";
import { localizeGeoUrls } from "../../../../src/app/geoAssets";

describe("localizeGeoUrls", () => {
    it("rewrites the US basemap to a local path", () => {
        const spec: any = {
            data: {
                url: "https://vega.github.io/vega-lite/data/us-10m.json",
                format: { type: "topojson", feature: "states" },
            },
        };
        localizeGeoUrls(spec);
        expect(spec.data.url).toBe("/geo/us-10m.json");
        expect(spec.data.format).toEqual({ type: "topojson", feature: "states" });
    });

    it("rewrites the world basemap nested inside a layer", () => {
        const spec: any = {
            layer: [
                { data: { url: "https://vega.github.io/vega-lite/data/world-110m.json" } },
                { mark: "circle" },
            ],
        };
        localizeGeoUrls(spec);
        expect(spec.layer[0].data.url).toBe("/geo/world-110m.json");
    });

    it("strips an unknown remote url and leaves empty inline data", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const spec: any = { data: { url: "https://evil.example.com/rows.json", format: { type: "json" } } };
        localizeGeoUrls(spec);
        expect(spec.data.url).toBeUndefined();
        expect(spec.data.format).toBeUndefined();
        expect(spec.data.values).toEqual([]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("leaves inline data and same-origin urls untouched", () => {
        const spec: any = {
            data: { values: [{ a: 1 }] },
            layer: [{ data: { url: "/geo/us-10m.json" } }],
        };
        localizeGeoUrls(spec);
        expect(spec.data.values).toEqual([{ a: 1 }]);
        expect(spec.layer[0].data.url).toBe("/geo/us-10m.json");
    });

    it("returns the same object it was given", () => {
        const spec: any = { data: { values: [] } };
        expect(localizeGeoUrls(spec)).toBe(spec);
    });
});
