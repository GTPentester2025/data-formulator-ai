/**
 * The pivot export must produce a real PivotTable object — cache definition,
 * cache records, and a pivot table wired to both the workbook and its sheet —
 * so the reader can re-drag fields in Excel rather than receive a frozen
 * cross-tab.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildXlsxWorkbook } from "../../../../src/app/xlsxWorkbook";

const rows = [
    { region: "North", quarter: "Q1", sales: 10 },
    { region: "North", quarter: "Q2", sales: 12 },
    { region: "South", quarter: "Q1", sales: 7 },
    { region: "South", quarter: "Q2", sales: 9 },
    { region: "East", quarter: "Q1", sales: 4 },
];
const columns = ["region", "quarter", "sales"];

const loadPivotWorkbook = async (extra: Parameters<typeof buildXlsxWorkbook>[0] | null = null) => {
    const blob = await buildXlsxWorkbook(extra ?? {
        data: { name: "Data", rows, columns },
        pivot: { rowField: "region", colField: "quarter", valueField: "sales", aggregation: "sum" },
    });
    return JSZip.loadAsync(await blob.arrayBuffer());
};

describe("pivot table export", () => {
    it("writes the cache definition, cache records and pivot table parts", async () => {
        const zip = await loadPivotWorkbook();
        for (const part of [
            "xl/pivotCache/pivotCacheDefinition1.xml",
            "xl/pivotCache/pivotCacheRecords1.xml",
            "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels",
            "xl/pivotTables/pivotTable1.xml",
            "xl/pivotTables/_rels/pivotTable1.xml.rels",
        ]) {
            expect(zip.file(part), `missing ${part}`).not.toBeNull();
        }
    });

    it("points the cache at the Data sheet range and enumerates axis values", async () => {
        const zip = await loadPivotWorkbook();
        const xml = await zip.file("xl/pivotCache/pivotCacheDefinition1.xml")!.async("string");

        expect(xml).toContain('<worksheetSource ref="A1:C6" sheet="Data"/>');
        expect(xml).toContain('recordCount="5"');
        // axis fields enumerate their distinct values; the measure does not
        expect(xml).toContain('<s v="North"/>');
        expect(xml).toContain('<s v="Q1"/>');
        expect(xml).toContain('containsNumber="1"');
        expect(xml).not.toContain('<s v="10"/>');
    });

    it("stores axis cells as shared-item indexes and measures inline", async () => {
        const zip = await loadPivotWorkbook();
        const xml = await zip.file("xl/pivotCache/pivotCacheRecords1.xml")!.async("string");

        expect(xml).toContain('count="5"');
        // first row: region North (index 0), quarter Q1 (index 0), sales 10
        expect(xml).toContain('<r><x v="0"/><x v="0"/><n v="10"/></r>');
        // South is the second distinct region, Q2 the second distinct quarter
        expect(xml).toContain('<r><x v="1"/><x v="1"/><n v="9"/></r>');
    });

    it("places the chosen fields in the row, column and data areas", async () => {
        const zip = await loadPivotWorkbook();
        const xml = await zip.file("xl/pivotTables/pivotTable1.xml")!.async("string");

        expect(xml).toContain('<rowFields count="1"><field x="0"/></rowFields>');
        expect(xml).toContain('<colFields count="1"><field x="1"/></colFields>');
        expect(xml).toContain('<dataField name="Sum of sales" fld="2"');
        expect(xml).toContain('axis="axisRow"');
        expect(xml).toContain('axis="axisCol"');
        // three regions plus the subtotal item
        expect(xml).toContain('<items count="4">');
    });

    it("registers the cache on the workbook and the table on its sheet", async () => {
        const zip = await loadPivotWorkbook();

        const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
        expect(workbookXml).toMatch(/<pivotCaches><pivotCache cacheId="1" r:id="rId\d+"\/><\/pivotCaches>/);
        expect(workbookXml).toContain('name="PivotTable"');

        const workbookRels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
        expect(workbookRels).toContain("pivotCache/pivotCacheDefinition1.xml");

        const sheetRels = Object.keys(zip.files).filter(p => /xl\/worksheets\/_rels\/.*\.rels$/.test(p));
        const relTexts = await Promise.all(sheetRels.map(p => zip.file(p)!.async("string")));
        expect(relTexts.some(t => t.includes("../pivotTables/pivotTable1.xml"))).toBe(true);
    });

    it("declares content types for all three pivot parts", async () => {
        const zip = await loadPivotWorkbook();
        const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
        expect(contentTypes).toContain("pivotCacheDefinition+xml");
        expect(contentTypes).toContain("pivotCacheRecords+xml");
        expect(contentTypes).toContain("pivotTable+xml");
    });

    it("omits colFields when no column field is chosen", async () => {
        const zip = await loadPivotWorkbook({
            data: { name: "Data", rows, columns },
            pivot: { rowField: "region", valueField: "sales" },
        });
        const xml = await zip.file("xl/pivotTables/pivotTable1.xml")!.async("string");
        expect(xml).not.toContain("<colFields");
        expect(xml).toContain('<colItems count="1"><i/></colItems>');
    });

    it("carries source sheets ahead of the data sheet, with unique names", async () => {
        const zip = await loadPivotWorkbook({
            data: { name: "Data", rows, columns },
            sourceSheets: [
                { name: "sales_2023.csv", rows: [{ a: 1 }], columns: ["a"] },
                { name: "sales_2023.csv", rows: [{ a: 2 }], columns: ["a"] },
            ],
        });
        const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
        const names = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map(m => m[1]);

        expect(names[0]).toBe("sales_2023.csv");
        expect(names[1]).toBe("sales_2023.csv (2)");
        expect(names[2]).toBe("Data");
    });

    it("can carry a chart and a pivot in the same workbook", async () => {
        const zip = await loadPivotWorkbook({
            data: { name: "Data", rows, columns },
            chart: {
                type: "col", categoryField: "region", seriesFields: ["sales"],
                rows: [{ region: "North", sales: 22 }, { region: "South", sales: 16 }],
            },
            pivot: { rowField: "region", valueField: "sales" },
        });
        expect(zip.file("xl/charts/chart1.xml")).not.toBeNull();
        expect(zip.file("xl/pivotTables/pivotTable1.xml")).not.toBeNull();

        const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
        for (const name of ["Data", "ChartData", "Chart", "PivotTable"]) {
            expect(workbookXml).toContain(`name="${name}"`);
        }
    });
});
