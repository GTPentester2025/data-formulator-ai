// Shared helpers for exporting tables and charts from the browser:
// blob downloads, XLSX generation (via exceljs, already a dependency for
// reading uploads), and copying chart images to the clipboard.

import * as ExcelJS from 'exceljs';
import * as d3dsv from 'd3-dsv';
import { getUrls, fetchWithIdentity } from './utils';
import type { Chart, EncodingItem, FieldItem } from '../components/ComponentType';
import type { NativeChartSpec, NativeChartType } from './xlsxChart';

/** Trigger a browser download of `blob` under `filename`. */
export const triggerBlobDownload = (blob: Blob, filename: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
};

/** Strip characters Excel forbids in sheet names, cap at 31 chars. */
const safeSheetName = (name: string) =>
    (name.replace(/[\\/*?:[\]]/g, ' ').trim() || 'Data').slice(0, 31);

/**
 * Resolve the FULL row set for a table. `DictTable.rows` may be a sample for
 * virtual (DuckDB-backed) tables, so those are streamed from the server via
 * the CSV export route and parsed client-side; in-memory tables are returned
 * as-is.
 */
export const resolveFullTableRows = async (
    tableId: string, rows: any[], virtual: boolean, virtualRowCount?: number,
): Promise<any[]> => {
    // For a virtual table with an unknown row count, assume the in-memory rows
    // are a sample and fetch from the server.
    const allRowsInMemory = !virtual
        || (virtualRowCount !== undefined && rows.length >= virtualRowCount);
    if (allRowsInMemory) {
        return rows;
    }
    const response = await fetchWithIdentity(getUrls().EXPORT_TABLE_CSV, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table_name: tableId, delimiter: ',' }),
    });
    if (!response.ok) {
        throw new Error(`Export failed (${response.status})`);
    }
    const text = await response.text();
    return d3dsv.csvParse(text) as any[];
};

const buildDataSheet = (workbook: ExcelJS.Workbook, sheetName: string, rows: any[], columns?: string[]) => {
    const sheet = workbook.addWorksheet(safeSheetName(sheetName));
    const names = (columns && columns.length > 0) ? columns : Object.keys(rows[0] ?? {});
    sheet.columns = names.map(name => ({ header: name, key: name, width: Math.min(40, Math.max(12, name.length + 4)) }));
    for (const row of rows) {
        sheet.addRow(names.map(name => row[name]));
    }
    sheet.getRow(1).font = { bold: true };
    return sheet;
};

const workbookToBlob = async (workbook: ExcelJS.Workbook): Promise<Blob> => {
    const buffer = await workbook.xlsx.writeBuffer();
    return new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
};

/** Build an .xlsx blob with a single data sheet. */
export const rowsToXlsxBlob = async (rows: any[], columns?: string[], sheetName = 'Data'): Promise<Blob> => {
    const workbook = new ExcelJS.Workbook();
    buildDataSheet(workbook, sheetName, rows, columns);
    return workbookToBlob(workbook);
};

/** Decode a data URL's intrinsic pixel size. */
export const getImageSize = (dataUrl: string): Promise<{ width: number; height: number }> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('Failed to decode chart image'));
        img.src = dataUrl;
    });

/**
 * Build an .xlsx blob with a data sheet plus a "Chart" sheet embedding the
 * chart PNG at its natural size (halved: renders are 2x-retina).
 */
export const rowsAndChartToXlsxBlob = async (
    rows: any[], columns: string[] | undefined, chartPngDataUrl: string, sheetName = 'Data',
): Promise<Blob> => {
    const workbook = new ExcelJS.Workbook();
    buildDataSheet(workbook, sheetName, rows, columns);
    const chartSheet = workbook.addWorksheet('Chart');
    const base64 = chartPngDataUrl.split(',', 2)[1];
    const imageId = workbook.addImage({ base64, extension: 'png' });
    const { width, height } = await getImageSize(chartPngDataUrl);
    chartSheet.addImage(imageId, {
        tl: { col: 1, row: 1 },
        ext: { width: Math.round(width / 2), height: Math.round(height / 2) },
    });
    return workbookToBlob(workbook);
};

export const pngDataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
    const response = await fetch(dataUrl);
    return response.blob();
};

/** Whether the clipboard image API is usable in this context. */
export const canCopyImageToClipboard = (): boolean =>
    typeof window !== 'undefined'
    && window.isSecureContext
    && !!navigator.clipboard
    && typeof navigator.clipboard.write === 'function'
    && typeof ClipboardItem !== 'undefined';

/** Copy a PNG data URL to the clipboard as an image. Throws on failure. */
export const copyPngDataUrlToClipboard = async (dataUrl: string): Promise<void> => {
    if (!canCopyImageToClipboard()) {
        throw new Error('Clipboard image copy requires a secure context (https or localhost)');
    }
    const blob = await pngDataUrlToBlob(dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
};

/** Sanitize a table/chart name into a safe filename stem. */
export const safeFileStem = (name: string) =>
    (name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'export').slice(0, 80);

// ── Translating a rendered chart into a native Excel chart ──────────────
//
// Excel can only draw a handful of chart forms, so a DF chart is exported as a
// real (editable, range-linked) Excel chart when it maps cleanly onto one of
// them, and falls back to an embedded image otherwise.

/** Beyond this many category points an Excel chart stops being usable. */
const MAX_NATIVE_CHART_POINTS = 5000;

const CHART_TYPE_PATTERNS: [RegExp, NativeChartType][] = [
    [/doughnut|donut/i, 'doughnut'],
    [/pie|rose/i, 'pie'],
    [/scatter|bubble|regression/i, 'scatter'],
    [/line|sparkline|bump|slope/i, 'line'],
    [/area|streamgraph/i, 'area'],
    [/bar|column|histogram|lollipop|pyramid|waterfall/i, 'col'],
];

const matchChartType = (chartType: string): NativeChartType | undefined =>
    CHART_TYPE_PATTERNS.find(([pattern]) => pattern.test(chartType))?.[1];

/**
 * Column name a channel's values land under in the plotted rows. Mirrors
 * prepVisTable: aggregated fields become `<field>_<agg>`, and `count` becomes
 * the synthetic `_count` column.
 */
const columnForEncoding = (
    encoding: EncodingItem | undefined, fields: FieldItem[],
): string | undefined => {
    if (!encoding?.fieldID) return undefined;
    if (encoding.aggregate === 'count') return '_count';
    const field = fields.find(f => f.id === encoding.fieldID);
    if (!field) return undefined;
    return encoding.aggregate ? `${field.name}_${encoding.aggregate}` : field.name;
};

const isNumericColumn = (rows: any[], column: string | undefined): boolean => {
    if (!column) return false;
    const sample = rows.slice(0, 50).map(r => r[column]).filter(v => v !== null && v !== undefined && v !== '');
    if (sample.length === 0) return false;
    return sample.every(v => Number.isFinite(typeof v === 'number' ? v : Number(v)));
};

/** Split one value column into several by a series field, preserving order. */
const pivotBySeries = (
    rows: any[], categoryField: string, valueField: string, seriesField: string,
): { rows: any[]; seriesFields: string[] } => {
    const categories: any[] = [];
    const seriesNames: string[] = [];
    const byCategory = new Map<string, any>();

    for (const row of rows) {
        const category = row[categoryField];
        const key = String(category);
        const seriesName = String(row[seriesField]);
        if (!byCategory.has(key)) {
            byCategory.set(key, { [categoryField]: category });
            categories.push(key);
        }
        if (!seriesNames.includes(seriesName)) seriesNames.push(seriesName);
        byCategory.get(key)[seriesName] = row[valueField];
    }

    return {
        rows: categories.map(key => byCategory.get(key)),
        seriesFields: seriesNames,
    };
};

/**
 * Describe `chart` as a native Excel chart over `plottedRows` (the same
 * aggregated rows the on-screen chart draws), or return null when the chart
 * form has no faithful Excel equivalent.
 */
export const resolveNativeChartSpec = (
    chart: Chart, conceptShelfItems: FieldItem[], plottedRows: any[],
): NativeChartSpec | null => {
    if (!plottedRows || plottedRows.length === 0) return null;

    let type = matchChartType(chart.chartType);
    if (!type) return null;

    const encodings = chart.encodingMap as Record<string, EncodingItem>;
    const colX = columnForEncoding(encodings?.x, conceptShelfItems);
    const colY = columnForEncoding(encodings?.y, conceptShelfItems);
    const colColor = columnForEncoding(encodings?.color, conceptShelfItems);
    const colTheta = columnForEncoding(encodings?.theta, conceptShelfItems);
    const colSize = columnForEncoding(encodings?.size, conceptShelfItems);

    let categoryField: string | undefined;
    let valueField: string | undefined;

    if (type === 'pie' || type === 'doughnut') {
        categoryField = colColor ?? colX ?? colY;
        valueField = colTheta ?? colY ?? colSize ?? colX;
    } else if (type === 'scatter') {
        categoryField = colX;
        valueField = colY;
        if (!isNumericColumn(plottedRows, categoryField) || !isNumericColumn(plottedRows, valueField)) {
            return null;
        }
    } else {
        // Bars/lines/areas plot a category against a measure; whichever axis
        // holds the non-numeric field is the category, which also decides
        // whether bars run vertically (col) or horizontally (bar).
        const xNumeric = isNumericColumn(plottedRows, colX);
        const yNumeric = isNumericColumn(plottedRows, colY);
        if (xNumeric && !yNumeric) {
            categoryField = colY;
            valueField = colX;
            if (type === 'col') type = 'bar';
        } else {
            categoryField = colX;
            valueField = colY;
        }
    }

    if (!categoryField || !valueField || categoryField === valueField) return null;
    if (!isNumericColumn(plottedRows, valueField)) return null;

    const seriesField = colColor && colColor !== categoryField && colColor !== valueField
        ? colColor
        : undefined;

    let rows: any[];
    let seriesFields: string[];
    if (seriesField && type !== 'pie' && type !== 'doughnut') {
        ({ rows, seriesFields } = pivotBySeries(plottedRows, categoryField, valueField, seriesField));
    } else {
        rows = plottedRows.map(r => ({ [categoryField!]: r[categoryField!], [valueField!]: r[valueField!] }));
        seriesFields = [valueField];
    }

    if (rows.length === 0 || rows.length > MAX_NATIVE_CHART_POINTS) return null;

    return {
        type,
        title: chart.title || undefined,
        categoryField,
        seriesFields,
        rows,
        categoryAxisTitle: categoryField,
        valueAxisTitle: seriesFields.length === 1 ? seriesFields[0] : valueField,
    };
};
