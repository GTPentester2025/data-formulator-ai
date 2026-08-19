// Assembles the .xlsx files this app hands to the user.
//
// One workbook can carry, in this order:
//   <source sheets>  the original uploaded tables a result was derived from
//   Data             the table currently in view
//   ChartData        the exact values the chart plots
//   Chart            a native, editable Excel chart bound to ChartData
//   PivotTable       a native pivot over the Data sheet
//
// Sheets come first so the workbook reads as a lineage: raw inputs, then the
// result, then what was drawn from it.

import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { safeSheetName, uniqueSheetNames } from './xlsxOoxml';
import { injectChartParts, type NativeChartSpec } from './xlsxChart';
import { injectPivotParts, type PivotAggregation } from './xlsxPivot';

export const DATA_SHEET = 'Data';
export const CHART_DATA_SHEET = 'ChartData';
export const CHART_SHEET = 'Chart';
export const PIVOT_SHEET = 'PivotTable';

export interface WorkbookSheet {
    name: string;
    rows: any[];
    columns?: string[];
}

/** Which fields the pivot puts in each area; columns come from the Data sheet. */
export interface PivotFields {
    rowField: string;
    colField?: string;
    valueField: string;
    aggregation?: PivotAggregation;
}

export interface WorkbookOptions {
    /** The table in view. */
    data: WorkbookSheet;
    /** Upstream tables this result was derived from, outermost first. */
    sourceSheets?: WorkbookSheet[];
    /** Adds ChartData + Chart sheets with a native chart. */
    chart?: NativeChartSpec;
    /** Adds a PivotTable sheet backed by a pivot cache over the Data sheet. */
    pivot?: PivotFields;
}

const columnsOf = (sheet: WorkbookSheet): string[] =>
    (sheet.columns && sheet.columns.length > 0)
        ? sheet.columns
        : Object.keys(sheet.rows[0] ?? {});

const addSheet = (workbook: ExcelJS.Workbook, name: string, rows: any[], columns: string[]) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns.map(n => ({
        header: n, key: n, width: Math.min(40, Math.max(12, n.length + 4)),
    }));
    for (const row of rows) sheet.addRow(columns.map(n => row[n]));
    if (columns.length > 0) sheet.getRow(1).font = { bold: true };
    return sheet;
};

/** Build the workbook described by `options` as a downloadable blob. */
export const buildXlsxWorkbook = async (options: WorkbookOptions): Promise<Blob> => {
    const { data, sourceSheets = [], chart, pivot } = options;

    const workbook = new ExcelJS.Workbook();

    // Source sheets are named after their tables and may collide with each
    // other or with the fixed names below, so resolve all names up front.
    const dataSheetName = safeSheetName(data.name || DATA_SHEET);
    const reserved = [dataSheetName, CHART_DATA_SHEET, CHART_SHEET, PIVOT_SHEET];
    const resolvedNames = uniqueSheetNames([
        ...reserved,
        ...sourceSheets.map(s => s.name),
    ]).slice(reserved.length);

    sourceSheets.forEach((sheet, i) => {
        addSheet(workbook, resolvedNames[i], sheet.rows, columnsOf(sheet));
    });

    const dataColumns = columnsOf(data);
    addSheet(workbook, dataSheetName, data.rows, dataColumns);

    if (chart) {
        // ChartData must be laid out exactly as the chart references it:
        // column A = categories, columns B.. = one per series.
        addSheet(workbook, CHART_DATA_SHEET, chart.rows, [chart.categoryField, ...chart.seriesFields]);
        workbook.addWorksheet(CHART_SHEET);
    }
    if (pivot) {
        workbook.addWorksheet(PIVOT_SHEET);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const zip = await JSZip.loadAsync(buffer as ArrayBuffer);

    if (chart) {
        await injectChartParts(zip, chart);
    }
    if (pivot) {
        await injectPivotParts(zip, {
            sourceSheet: dataSheetName,
            sourceColumns: dataColumns,
            sourceRows: data.rows,
            targetSheet: PIVOT_SHEET,
            ...pivot,
        });
    }

    return zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
};

/** Backwards-compatible helper: one data sheet plus a native chart. */
export const buildXlsxWithNativeChart = async (
    dataRows: any[],
    dataColumns: string[] | undefined,
    spec: NativeChartSpec,
    dataSheetName = DATA_SHEET,
): Promise<Blob> => buildXlsxWorkbook({
    data: { name: safeSheetName(dataSheetName), rows: dataRows, columns: dataColumns },
    chart: spec,
});
