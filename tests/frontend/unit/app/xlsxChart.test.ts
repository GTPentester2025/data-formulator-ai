/**
 * The "table + chart" export must produce a real Excel chart bound to
 * worksheet ranges — not a picture — so it stays editable and recalculates
 * from its source cells.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildXlsxWithNativeChart, columnLetter, type NativeChartSpec } from "../../../../src/app/xlsxChart";

const spec: NativeChartSpec = {
    type: "col",
    title: "Sales by region",
    categoryField: "region",
    seriesFields: ["2023", "2024"],
    rows: [
        { region: "North", "2023": 10, "2024": 12 },
        { region: "South", "2023": 7, "2024": 9 },
        { region: "East", "2023": 4, "2024": 5 },
    ],
    categoryAxisTitle: "region",
    valueAxisTitle: "sales_sum",
};

const dataRows = [
    { region: "North", year: 2023, sales: 10 },
    { region: "South", year: 2023, sales: 7 },
];

const loadWorkbook = async () => {
    const blob = await buildXlsxWithNativeChart(dataRows, ["region", "year", "sales"], spec, "Data");
    return JSZip.loadAsync(await blob.arrayBuffer());
};

describe("columnLetter", () => {
    it("maps 1-based indexes to spreadsheet letters", () => {
        expect(columnLetter(1)).toBe("A");
        expect(columnLetter(26)).toBe("Z");
        expect(columnLetter(27)).toBe("AA");
    });
});

describe("buildXlsxWithNativeChart", () => {
    it("emits the chart, drawing and relationship parts", async () => {
        const zip = await loadWorkbook();
        for (const part of [
            "xl/charts/chart1.xml",
            "xl/drawings/drawing1.xml",
            "xl/drawings/_rels/drawing1.xml.rels",
        ]) {
            expect(zip.file(part), `missing ${part}`).not.toBeNull();
        }
    });

    it("declares content types for the chart and drawing", async () => {
        const zip = await loadWorkbook();
        const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
        expect(contentTypes).toContain("drawingml.chart+xml");
        expect(contentTypes).toContain("officedocument.drawing+xml");
    });

    it("binds every series to a ChartData range rather than embedding values only", async () => {
        const zip = await loadWorkbook();
        const chartXml = await zip.file("xl/charts/chart1.xml")!.async("string");

        // 3 data rows → rows 2..4, categories in column A, series in B and C.
        expect(chartXml).toContain("<c:f>'ChartData'!$A$2:$A$4</c:f>");
        expect(chartXml).toContain("<c:f>'ChartData'!$B$2:$B$4</c:f>");
        expect(chartXml).toContain("<c:f>'ChartData'!$C$2:$C$4</c:f>");
        // series names come from the header row
        expect(chartXml).toContain("<c:f>'ChartData'!$B$1</c:f>");
        expect(chartXml).toContain('<c:barChart><c:barDir val="col"/>');
        expect(chartXml).toContain("Sales by region");
    });

    it("links the Chart worksheet to the drawing", async () => {
        const zip = await loadWorkbook();
        const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
        expect(workbookXml).toContain('name="ChartData"');
        expect(workbookXml).toContain('name="Chart"');

        const sheetRels = Object.keys(zip.files).filter(p => /xl\/worksheets\/_rels\/.*\.rels$/.test(p));
        expect(sheetRels.length).toBeGreaterThan(0);
        const relsXml = await zip.file(sheetRels[0])!.async("string");
        expect(relsXml).toContain("../drawings/drawing1.xml");

        const sheetPath = sheetRels[0].replace("/_rels", "").replace(".rels", "");
        const sheetXml = await zip.file(sheetPath)!.async("string");
        expect(sheetXml).toMatch(/<drawing r:id="rId\d+"\/><\/worksheet>/);
        expect(sheetXml).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    });

    it("writes both the full data sheet and the chart's own data sheet", async () => {
        const zip = await loadWorkbook();
        const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
        expect(workbookXml).toContain('name="Data"');
    });

    it("omits axes for pie charts and keeps them for bar charts", async () => {
        const pieBlob = await buildXlsxWithNativeChart(
            dataRows, undefined,
            { ...spec, type: "pie", seriesFields: ["2023"], title: undefined },
            "Data",
        );
        const pieXml = await (await JSZip.loadAsync(await pieBlob.arrayBuffer()))
            .file("xl/charts/chart1.xml")!.async("string");
        expect(pieXml).toContain("<c:pieChart>");
        expect(pieXml).not.toContain("<c:catAx>");

        const zip = await loadWorkbook();
        const barXml = await zip.file("xl/charts/chart1.xml")!.async("string");
        expect(barXml).toContain("<c:catAx>");
        expect(barXml).toContain("<c:valAx>");
    });

    it("escapes XML-hostile characters in labels", async () => {
        const blob = await buildXlsxWithNativeChart(
            dataRows, undefined,
            {
                ...spec,
                title: 'Q1 & "growth" <2024>',
                seriesFields: ["2023"],
                rows: [{ region: "A & B", "2023": 1 }],
            },
            "Data",
        );
        const xml = await (await JSZip.loadAsync(await blob.arrayBuffer()))
            .file("xl/charts/chart1.xml")!.async("string");
        expect(xml).toContain('Q1 &amp; "growth" &lt;2024&gt;');
        expect(xml).toContain("A &amp; B");
    });
});
