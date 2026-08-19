// Writes .xlsx workbooks containing a NATIVE Excel chart — a real chart object
// whose series point at worksheet ranges, so it stays editable in Excel and
// updates when the linked cells change. (exceljs can write worksheets but not
// charts, so the workbook is built with exceljs and the chart parts are
// injected into the resulting OOXML package afterwards.)

import JSZip from 'jszip';
import { columnLetter, escapeXml, nextRelId, resolveSheetPath } from './xlsxOoxml';

export type NativeChartType = 'col' | 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'doughnut';

export interface NativeChartSpec {
    type: NativeChartType;
    title?: string;
    /** Column in `rows` holding category labels (X values for scatter). */
    categoryField: string;
    /** One column per series; each becomes a chart series. */
    seriesFields: string[];
    /** The exact values the on-screen chart plots (already aggregated). */
    rows: any[];
    categoryAxisTitle?: string;
    valueAxisTitle?: string;
}

const CHART_SHEET = 'Chart';
const CHART_DATA_SHEET = 'ChartData';

const CAT_AX_ID = 111111111;
const VAL_AX_ID = 222222222;

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

const sheetRef = (sheet: string, col: string, fromRow: number, toRow?: number) =>
    toRow === undefined
        ? `'${sheet}'!$${col}$${fromRow}`
        : `'${sheet}'!$${col}$${fromRow}:$${col}$${toRow}`;

const toNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
};

const strCache = (values: unknown[]) => `<c:strCache><c:ptCount val="${values.length}"/>${
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join('')
}</c:strCache>`;

const numCache = (values: (number | null)[]) => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${
    values.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')
}</c:numCache>`;

const titleXml = (text: string) =>
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

const axisTitleXml = (text?: string) => (text ? titleXml(text) : '');

/**
 * Build `xl/charts/chart1.xml`: a chart whose category/value references are
 * worksheet ranges on the ChartData sheet.
 */
const buildChartXml = (spec: NativeChartSpec): string => {
    const { type, rows, categoryField, seriesFields } = spec;
    const rowCount = rows.length;
    const firstDataRow = 2;                 // row 1 holds headers
    const lastDataRow = rowCount + 1;

    const catCol = columnLetter(1);
    const categories = rows.map(r => r[categoryField]);
    const catRef = sheetRef(CHART_DATA_SHEET, catCol, firstDataRow, lastDataRow);

    const isScatter = type === 'scatter';
    const isPie = type === 'pie' || type === 'doughnut';

    const series = seriesFields.map((field, seriesIndex) => {
        const col = columnLetter(seriesIndex + 2);
        const values = rows.map(r => toNumber(r[field]));
        const nameRef = sheetRef(CHART_DATA_SHEET, col, 1);
        const valRef = sheetRef(CHART_DATA_SHEET, col, firstDataRow, lastDataRow);

        const txXml = `<c:tx><c:strRef><c:f>${escapeXml(nameRef)}</c:f>${strCache([field])}</c:strRef></c:tx>`;

        if (isScatter) {
            const xValues = rows.map(r => toNumber(r[categoryField]));
            return `<c:ser><c:idx val="${seriesIndex}"/><c:order val="${seriesIndex}"/>${txXml}`
                + `<c:spPr><a:ln w="28575"><a:noFill/></a:ln></c:spPr>`
                + `<c:xVal><c:numRef><c:f>${escapeXml(catRef)}</c:f>${numCache(xValues)}</c:numRef></c:xVal>`
                + `<c:yVal><c:numRef><c:f>${escapeXml(valRef)}</c:f>${numCache(values)}</c:numRef></c:yVal>`
                + `<c:smooth val="0"/></c:ser>`;
        }

        const catXml = `<c:cat><c:strRef><c:f>${escapeXml(catRef)}</c:f>${strCache(categories)}</c:strRef></c:cat>`;
        const valXml = `<c:val><c:numRef><c:f>${escapeXml(valRef)}</c:f>${numCache(values)}</c:numRef></c:val>`;
        const smooth = type === 'line' ? '<c:smooth val="0"/>' : '';
        return `<c:ser><c:idx val="${seriesIndex}"/><c:order val="${seriesIndex}"/>${txXml}${catXml}${valXml}${smooth}</c:ser>`;
    }).join('');

    const axIds = `<c:axId val="${CAT_AX_ID}"/><c:axId val="${VAL_AX_ID}"/>`;

    let plot: string;
    if (type === 'col' || type === 'bar') {
        plot = `<c:barChart><c:barDir val="${type}"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
            + `${series}<c:gapWidth val="80"/><c:overlap val="-20"/>${axIds}</c:barChart>`;
    } else if (type === 'line') {
        plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}`
            + `<c:marker val="1"/>${axIds}</c:lineChart>`;
    } else if (type === 'area') {
        plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${axIds}</c:areaChart>`;
    } else if (isScatter) {
        plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series}${axIds}</c:scatterChart>`;
    } else {
        // Pie / doughnut carry no axes.
        const hole = type === 'doughnut' ? '<c:holeSize val="50"/>' : '';
        const tag = type === 'doughnut' ? 'doughnutChart' : 'pieChart';
        plot = `<c:${tag}><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/>${hole}</c:${tag}>`;
    }

    let axes = '';
    if (!isPie) {
        const catAxTag = isScatter ? 'valAx' : 'catAx';
        axes = `<c:${catAxTag}><c:axId val="${CAT_AX_ID}"/><c:scaling><c:orientation val="minMax"/></c:scaling>`
            + `<c:delete val="0"/><c:axPos val="b"/>${axisTitleXml(spec.categoryAxisTitle)}`
            + `<c:crossAx val="${VAL_AX_ID}"/></c:${catAxTag}>`
            + `<c:valAx><c:axId val="${VAL_AX_ID}"/><c:scaling><c:orientation val="minMax"/></c:scaling>`
            + `<c:delete val="0"/><c:axPos val="l"/>${axisTitleXml(spec.valueAxisTitle)}`
            + `<c:majorGridlines/><c:crossAx val="${CAT_AX_ID}"/></c:valAx>`;
    }

    const legend = seriesFields.length > 1 || isPie
        ? '<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>'
        : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">`
        + `<c:chart>${spec.title ? titleXml(spec.title) : ''}`
        + `<c:autoTitleDeleted val="${spec.title ? 0 : 1}"/>`
        + `<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}`
        + `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
};

const buildDrawingXml = (relId: string): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">`
    + `<xdr:twoCellAnchor>`
    + `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>26</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
    + `<xdr:graphicFrame macro="">`
    + `<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
    + `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>`
    + `<a:graphic><a:graphicData uri="${NS_C}">`
    + `<c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${relId}"/>`
    + `</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;

/** Add the chart, drawing, rels and content-type entries to an exceljs package. */
export const injectChartParts = async (zip: JSZip, spec: NativeChartSpec): Promise<void> => {
    zip.file('xl/charts/chart1.xml', buildChartXml(spec));

    // drawing → chart
    zip.file(
        'xl/drawings/_rels/drawing1.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>`
        + `</Relationships>`,
    );
    zip.file('xl/drawings/drawing1.xml', buildDrawingXml('rId1'));

    // sheet → drawing
    const sheetPath = await resolveSheetPath(zip, CHART_SHEET);
    const sheetFile = sheetPath.replace(/^xl\//, '');
    const sheetRelsPath = `xl/${sheetFile.replace(/([^/]+)$/, '_rels/$1.rels')}`;

    const existingRels = zip.file(sheetRelsPath);
    let relsXml = existingRels
        ? await existingRels.async('string')
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
          + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const drawingRelId = nextRelId(relsXml);
    relsXml = relsXml.replace(
        '</Relationships>',
        `<Relationship Id="${drawingRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    );
    zip.file(sheetRelsPath, relsXml);

    let sheetXml = await zip.file(sheetPath)!.async('string');
    // `r:id` on the drawing element needs the relationships namespace declared.
    if (!/<worksheet[^>]*xmlns:r=/.test(sheetXml)) {
        sheetXml = sheetXml.replace(/<worksheet\b/, `<worksheet xmlns:r="${NS_R}"`);
    }
    sheetXml = sheetXml.replace('</worksheet>', `<drawing r:id="${drawingRelId}"/></worksheet>`);
    zip.file(sheetPath, sheetXml);

    // content types
    const ctPath = '[Content_Types].xml';
    let contentTypes = await zip.file(ctPath)!.async('string');
    const overrides = [
        '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
        '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>',
    ].filter(entry => !contentTypes.includes(entry)).join('');
    contentTypes = contentTypes.replace('</Types>', `${overrides}</Types>`);
    zip.file(ctPath, contentTypes);
};

export const CHART_SHEET_NAME = CHART_SHEET;
export const CHART_DATA_SHEET_NAME = CHART_DATA_SHEET;

export const __testing = { buildChartXml, buildDrawingXml };
