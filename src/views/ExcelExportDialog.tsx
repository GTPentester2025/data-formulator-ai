/**
 * ExcelExportDialog — picks what goes into an exported workbook.
 *
 * The data sheet is always written; everything else is opt-in, because each
 * extra costs something: the chart and pivot add Excel objects, and source
 * data can pull large upstream tables from the server.
 */

import { FC, useEffect, useState } from 'react';
import {
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { textVar } from '../app/layout';

export interface ExcelExportChoices {
    chart: boolean;
    pivot: boolean;
    sourceData: boolean;
}

interface ExcelExportDialogProps {
    open: boolean;
    onClose: () => void;
    onExport: (choices: ExcelExportChoices) => void;
    /** Hide the chart option when the view has no chart to export. */
    chartAvailable?: boolean;
    /** Number of upstream tables available; hides the option when zero. */
    sourceTableCount?: number;
    busy?: boolean;
}

const defaultChoices = (chartAvailable: boolean): ExcelExportChoices => ({
    chart: chartAvailable,
    pivot: false,
    sourceData: false,
});

export const ExcelExportDialog: FC<ExcelExportDialogProps> = ({
    open, onClose, onExport, chartAvailable = false, sourceTableCount = 0, busy = false,
}) => {
    const { t } = useTranslation();
    const [choices, setChoices] = useState<ExcelExportChoices>(() => defaultChoices(chartAvailable));

    // Re-arm the defaults each time the dialog opens so a previous run's
    // choices don't silently apply to a different chart or table.
    useEffect(() => {
        if (open) setChoices(defaultChoices(chartAvailable));
    }, [open, chartAvailable]);

    const toggle = (key: keyof ExcelExportChoices) => (_: unknown, checked: boolean) =>
        setChoices(prev => ({ ...prev, [key]: checked }));

    const option = (
        key: keyof ExcelExportChoices,
        label: string,
        description: string,
    ) => (
        <Box sx={{ mb: 1 }}>
            <FormControlLabel
                control={<Checkbox size="small" checked={choices[key]} onChange={toggle(key)} />}
                label={<Typography sx={{ fontSize: textVar.md }}>{label}</Typography>}
            />
            <Typography sx={{ fontSize: textVar.sm, color: 'text.secondary', ml: 4, mt: -0.5 }}>
                {description}
            </Typography>
        </Box>
    );

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ fontSize: textVar.lg, fontWeight: 600 }}>
                {t('export.excelTitle', { defaultValue: 'Download Excel' })}
            </DialogTitle>
            <DialogContent>
                <Typography sx={{ fontSize: textVar.sm, color: 'text.secondary', mb: 1.5 }}>
                    {t('export.excelIntro', {
                        defaultValue: 'The table in view is always included, as a "Data" sheet.',
                    })}
                </Typography>

                {chartAvailable && option(
                    'chart',
                    t('export.optionChart', { defaultValue: 'Chart' }),
                    t('export.optionChartDesc', {
                        defaultValue: 'A native Excel chart linked to the values it plots, on its own sheet.',
                    }),
                )}

                {option(
                    'pivot',
                    t('export.optionPivot', { defaultValue: 'Pivot table' }),
                    t('export.optionPivotDesc', {
                        defaultValue: 'An interactive PivotTable over the data — drag fields to re-slice it in Excel.',
                    }),
                )}

                {sourceTableCount > 0 && option(
                    'sourceData',
                    t('export.optionSource', { defaultValue: 'Source data' }),
                    t('export.optionSourceDesc', {
                        defaultValue: 'The tables this result was derived from, one sheet each, so the steps are visible.',
                        count: sourceTableCount,
                    }),
                )}
            </DialogContent>
            <DialogActions>
                <Button size="small" onClick={onClose} sx={{ textTransform: 'none' }}>
                    {t('export.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button
                    size="small"
                    variant="contained"
                    disabled={busy}
                    onClick={() => onExport(choices)}
                    sx={{ textTransform: 'none' }}
                >
                    {t('export.download', { defaultValue: 'Download' })}
                </Button>
            </DialogActions>
        </Dialog>
    );
};
