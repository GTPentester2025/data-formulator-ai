// Shared plumbing for writing extra OOXML parts into an .xlsx package built by
// exceljs (which can write worksheets, but not charts or pivot tables).

import JSZip from 'jszip';

/**
 * Escape text destined for an XML text node. Everything these writers emit is
 * element text rather than an attribute value, so only the three characters
 * that can end a text node need escaping — leaving quotes alone keeps sheet
 * references readable: 'ChartData'!$A$2 rather than &apos;ChartData&apos;!$A$2.
 */
export const escapeXml = (value: unknown): string =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

/** 1-based column index → spreadsheet column letters (1 → A, 27 → AA). */
export const columnLetter = (index: number): string => {
    let n = index;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
};

/** Next free rIdN in a relationships document. */
export const nextRelId = (relsXml: string): string => {
    const used = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]));
    return `rId${(used.length ? Math.max(...used) : 0) + 1}`;
};

/** Resolve the worksheet part path for a sheet name, via the workbook rels. */
export const resolveSheetPath = async (zip: JSZip, sheetName: string): Promise<string> => {
    const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
    const sheetMatch = new RegExp(`<sheet[^>]*name="${sheetName}"[^>]*/>`).exec(workbookXml);
    if (!sheetMatch) throw new Error(`Worksheet "${sheetName}" not found in workbook`);
    const relIdMatch = /r:id="([^"]+)"/.exec(sheetMatch[0]);
    if (!relIdMatch) throw new Error(`Worksheet "${sheetName}" has no relationship id`);

    const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
    const targetMatch = new RegExp(`<Relationship[^>]*Id="${relIdMatch[1]}"[^>]*Target="([^"]+)"`).exec(relsXml);
    if (!targetMatch) throw new Error(`No workbook relationship for ${relIdMatch[1]}`);

    return `xl/${targetMatch[1].replace(/^\/?xl\//, '').replace(/^\.\//, '')}`;
};

/** Strip characters Excel forbids in sheet names and cap at its 31-char limit. */
export const safeSheetName = (name: string): string =>
    (String(name ?? '').replace(/[\\/*?:[\]]/g, ' ').trim() || 'Sheet').slice(0, 31);

/**
 * Make sheet names unique within a workbook, preserving the first occurrence
 * and suffixing later collisions (Excel rejects duplicates, case-insensitively).
 */
export const uniqueSheetNames = (names: string[]): string[] => {
    const used = new Set<string>();
    return names.map(raw => {
        const base = safeSheetName(raw);
        let candidate = base;
        let n = 2;
        while (used.has(candidate.toLowerCase())) {
            const suffix = ` (${n})`;
            candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
            n += 1;
        }
        used.add(candidate.toLowerCase());
        return candidate;
    });
};
