// Writes a NATIVE Excel PivotTable into an .xlsx package: a real pivot object
// backed by a pivot cache over a worksheet range, so the reader can drag
// fields between Rows/Columns/Values, filter, and refresh — not a static
// cross-tab of numbers.
//
// Three parts make a pivot table: a cache definition (which columns exist and
// what distinct values they hold), cache records (the source rows), and the
// pivot table itself (which fields sit in which area). They are wired to the
// workbook and to the hosting worksheet through relationships.

import JSZip from 'jszip';
import { columnLetter, escapeXml, nextRelId, resolveSheetPath } from './xlsxOoxml';

export type PivotAggregation = 'sum' | 'count' | 'average';

export interface PivotSpec {
    /** Worksheet holding the flat source rows the pivot reads. */
    sourceSheet: string;
    /** Source columns, in worksheet order — column A is `sourceColumns[0]`. */
    sourceColumns: string[];
    /** The source rows, used to build the pivot cache. */
    sourceRows: any[];
    /** Worksheet the pivot table is placed on. */
    targetSheet: string;
    /** Column shown down the left of the pivot. */
    rowField: string;
    /** Optional column shown across the top. */
    colField?: string;
    /** Column summarized in the values area. */
    valueField: string;
    aggregation?: PivotAggregation;
}

/** Excel slows to a crawl well before this; keeps the cache a sane size. */
export const MAX_PIVOT_CACHE_ROWS = 100_000;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const isBlank = (value: unknown) => value === null || value === undefined || value === '';

const asNumber = (value: unknown): number | null => {
    if (isBlank(value)) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
};

interface CacheField {
    name: string;
    /** Distinct values, when the field is used as a row/column axis. */
    sharedItems?: unknown[];
    /** True when every non-blank value parses as a number. */
    numeric: boolean;
}

const buildCacheFields = (spec: PivotSpec, rows: any[]): CacheField[] =>
    spec.sourceColumns.map(name => {
        const values = rows.map(r => r[name]);
        const numeric = values.some(v => !isBlank(v))
            && values.every(v => isBlank(v) || asNumber(v) !== null);
        // Only axis fields need their distinct values enumerated; enumerating a
        // measure would bloat the cache for no benefit.
        const isAxis = name === spec.rowField || name === spec.colField;
        if (!isAxis) return { name, numeric };

        const seen = new Set<string>();
        const sharedItems: unknown[] = [];
        for (const value of values) {
            if (isBlank(value)) continue;
            const key = String(value);
            if (seen.has(key)) continue;
            seen.add(key);
            sharedItems.push(numeric ? asNumber(value) : key);
        }
        return { name, numeric, sharedItems };
    });

const sharedItemsXml = (field: CacheField): string => {
    if (!field.sharedItems) {
        return field.numeric
            ? '<sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"/>'
            : '<sharedItems/>';
    }
    const items = field.sharedItems
        .map(v => (field.numeric ? `<n v="${v}"/>` : `<s v="${escapeXml(v)}"/>`))
        .join('');
    const attrs = field.numeric
        ? ' containsSemiMixedTypes="0" containsString="0" containsNumber="1"'
        : '';
    return `<sharedItems${attrs} count="${field.sharedItems.length}">${items}</sharedItems>`;
};

const buildCacheDefinition = (spec: PivotSpec, fields: CacheField[], rows: any[]): string => {
    const lastCol = columnLetter(spec.sourceColumns.length);
    const ref = `A1:${lastCol}${rows.length + 1}`;
    const cacheFields = fields
        .map(f => `<cacheField name="${escapeXml(f.name)}" numFmtId="0">${sharedItemsXml(f)}</cacheField>`)
        .join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<pivotCacheDefinition xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" r:id="rId1"`
        + ` refreshOnLoad="1" refreshedVersion="3" createdVersion="3" minRefreshableVersion="3"`
        + ` recordCount="${rows.length}">`
        + `<cacheSource type="worksheet">`
        + `<worksheetSource ref="${ref}" sheet="${escapeXml(spec.sourceSheet)}"/>`
        + `</cacheSource>`
        + `<cacheFields count="${fields.length}">${cacheFields}</cacheFields>`
        + `</pivotCacheDefinition>`;
};

const buildCacheRecords = (fields: CacheField[], rows: any[]): string => {
    // Axis fields are stored as indexes into their shared-item list; everything
    // else is stored inline.
    const indexLookup = fields.map(f => {
        if (!f.sharedItems) return null;
        const map = new Map<string, number>();
        f.sharedItems.forEach((v, i) => map.set(String(v), i));
        return map;
    });

    const records = rows.map(row => {
        const cells = fields.map((field, i) => {
            const value = row[field.name];
            const lookup = indexLookup[i];
            if (lookup) {
                if (isBlank(value)) return '<m/>';
                const key = field.numeric ? String(asNumber(value)) : String(value);
                const idx = lookup.get(key);
                return idx === undefined ? '<m/>' : `<x v="${idx}"/>`;
            }
            if (isBlank(value)) return '<m/>';
            const n = asNumber(value);
            return field.numeric && n !== null ? `<n v="${n}"/>` : `<s v="${escapeXml(value)}"/>`;
        }).join('');
        return `<r>${cells}</r>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<pivotCacheRecords xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" count="${rows.length}">`
        + records
        + `</pivotCacheRecords>`;
};

const SUBTOTAL_ATTR: Record<PivotAggregation, string> = {
    sum: '',                        // sum is Excel's default
    count: ' subtotal="count"',
    average: ' subtotal="average"',
};

const AGG_LABEL: Record<PivotAggregation, string> = {
    sum: 'Sum',
    count: 'Count',
    average: 'Average',
};

const buildPivotTable = (spec: PivotSpec, fields: CacheField[]): string => {
    const aggregation = spec.aggregation ?? 'sum';
    const rowIndex = spec.sourceColumns.indexOf(spec.rowField);
    const colIndex = spec.colField ? spec.sourceColumns.indexOf(spec.colField) : -1;
    const valueIndex = spec.sourceColumns.indexOf(spec.valueField);

    const pivotFields = fields.map((field, i) => {
        if (i === rowIndex || i === colIndex) {
            const axis = i === rowIndex ? 'axisRow' : 'axisCol';
            const count = (field.sharedItems?.length ?? 0) + 1;   // + the subtotal row
            const items = (field.sharedItems ?? [])
                .map((_, idx) => `<item x="${idx}"/>`)
                .join('') + '<item t="default"/>';
            return `<pivotField axis="${axis}" showAll="0"><items count="${count}">${items}</items></pivotField>`;
        }
        if (i === valueIndex) return '<pivotField dataField="1" showAll="0"/>';
        return '<pivotField showAll="0"/>';
    }).join('');

    const rowItemCount = fields[rowIndex]?.sharedItems?.length ?? 0;
    const rowItems = Array.from({ length: rowItemCount }, (_, i) => `<i><x v="${i}"/></i>`).join('')
        + '<i t="grand"><x/></i>';

    const colItemCount = colIndex >= 0 ? (fields[colIndex]?.sharedItems?.length ?? 0) : 0;
    const colFieldsXml = colIndex >= 0 ? `<colFields count="1"><field x="${colIndex}"/></colFields>` : '';
    const colItemsXml = colIndex >= 0
        ? `<colItems count="${colItemCount + 1}">${
            Array.from({ length: colItemCount }, (_, i) => `<i><x v="${i}"/></i>`).join('')
        }<i t="grand"><x/></i></colItems>`
        : '<colItems count="1"><i/></colItems>';

    // Header row, one row per category, plus the grand-total row.
    const lastRow = 3 + rowItemCount + 1;
    const lastCol = columnLetter(1 + Math.max(1, colItemCount) + (colIndex >= 0 ? 1 : 0));
    const location = `<location ref="A3:${lastCol}${lastRow}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>`;

    const dataFieldName = `${AGG_LABEL[aggregation]} of ${spec.valueField}`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<pivotTableDefinition xmlns="${NS_MAIN}" name="PivotTable1" cacheId="1"`
        + ` applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0"`
        + ` applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1"`
        + ` dataCaption="Values" updatedVersion="3" minRefreshableVersion="3" createdVersion="3"`
        + ` itemPrintTitles="1" useAutoFormatting="1" indent="0" outline="1" outlineData="1"`
        + ` multipleFieldFilters="0">`
        + location
        + `<pivotFields count="${fields.length}">${pivotFields}</pivotFields>`
        + `<rowFields count="1"><field x="${rowIndex}"/></rowFields>`
        + `<rowItems count="${rowItemCount + 1}">${rowItems}</rowItems>`
        + colFieldsXml
        + colItemsXml
        + `<dataFields count="1">`
        + `<dataField name="${escapeXml(dataFieldName)}" fld="${valueIndex}"`
        + `${SUBTOTAL_ATTR[aggregation]} baseField="0" baseItem="0"/>`
        + `</dataFields>`
        + `<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1"`
        + ` showRowStripes="0" showColStripes="0" showLastColumn="1"/>`
        + `</pivotTableDefinition>`;
};

/** Add the pivot cache, pivot table, and their relationships to `zip`. */
export const injectPivotParts = async (zip: JSZip, spec: PivotSpec): Promise<void> => {
    const rows = spec.sourceRows.slice(0, MAX_PIVOT_CACHE_ROWS);
    const fields = buildCacheFields(spec, rows);

    zip.file('xl/pivotCache/pivotCacheDefinition1.xml', buildCacheDefinition(spec, fields, rows));
    zip.file('xl/pivotCache/pivotCacheRecords1.xml', buildCacheRecords(fields, rows));
    zip.file(
        'xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${NS_REL}/pivotCacheRecords" Target="pivotCacheRecords1.xml"/>`
        + `</Relationships>`,
    );

    zip.file('xl/pivotTables/pivotTable1.xml', buildPivotTable(spec, fields));
    zip.file(
        'xl/pivotTables/_rels/pivotTable1.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${NS_REL}/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/>`
        + `</Relationships>`,
    );

    // workbook → pivot cache
    const workbookRelsPath = 'xl/_rels/workbook.xml.rels';
    let workbookRels = await zip.file(workbookRelsPath)!.async('string');
    const cacheRelId = nextRelId(workbookRels);
    workbookRels = workbookRels.replace(
        '</Relationships>',
        `<Relationship Id="${cacheRelId}" Type="${NS_REL}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/></Relationships>`,
    );
    zip.file(workbookRelsPath, workbookRels);

    let workbookXml = await zip.file('xl/workbook.xml')!.async('string');
    if (!/<workbook[^>]*xmlns:r=/.test(workbookXml)) {
        workbookXml = workbookXml.replace(/<workbook\b/, `<workbook xmlns:r="${NS_REL}"`);
    }
    workbookXml = workbookXml.replace(
        '</workbook>',
        `<pivotCaches><pivotCache cacheId="1" r:id="${cacheRelId}"/></pivotCaches></workbook>`,
    );
    zip.file('xl/workbook.xml', workbookXml);

    // hosting worksheet → pivot table
    const sheetPath = await resolveSheetPath(zip, spec.targetSheet);
    const sheetRelsPath = `xl/${sheetPath.replace(/^xl\//, '').replace(/([^/]+)$/, '_rels/$1.rels')}`;
    const existing = zip.file(sheetRelsPath);
    let sheetRels = existing
        ? await existing.async('string')
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
          + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const pivotRelId = nextRelId(sheetRels);
    sheetRels = sheetRels.replace(
        '</Relationships>',
        `<Relationship Id="${pivotRelId}" Type="${NS_REL}/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>`,
    );
    zip.file(sheetRelsPath, sheetRels);

    const ctPath = '[Content_Types].xml';
    let contentTypes = await zip.file(ctPath)!.async('string');
    const overrides = [
        '<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>',
        '<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>',
        '<Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>',
    ].filter(entry => !contentTypes.includes(entry)).join('');
    zip.file(ctPath, contentTypes.replace('</Types>', `${overrides}</Types>`));
};

export const __testing = { buildCacheFields, buildCacheDefinition, buildCacheRecords, buildPivotTable };
