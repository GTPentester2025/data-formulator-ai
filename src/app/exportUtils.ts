// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Shared helpers for exporting tables and charts from the browser:
// blob downloads, XLSX generation (via exceljs, already a dependency for
// reading uploads), and copying chart images to the clipboard.

import * as ExcelJS from 'exceljs';
import * as d3dsv from 'd3-dsv';
import { getUrls, fetchWithIdentity } from './utils';

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
