import React, { useEffect, useMemo, useState } from 'react';
import '../scss/App.scss';

import { useDispatch, useSelector } from "react-redux";
import { 
    DataFormulatorState,
    dfActions,
    ModelConfig,
    dfSelectors,
} from '../app/dfSlice'
import _ from 'lodash';

import {
    Button,
    Tooltip,
    Typography,
    IconButton,
    DialogTitle,
    Dialog,
    DialogContent,
    DialogActions,
    TextField,
    Autocomplete,
    CircularProgress,
    FormControl,
    Select,
    SelectChangeEvent,
    OutlinedInput,
    Paper,
    Box,
    Divider,
    Checkbox,
    Switch,
    FormControlLabel,
    Accordion,
    AccordionSummary,
    AccordionDetails,
} from '@mui/material';


import { styled } from '@mui/material/styles';

import AddCircleIcon from '@mui/icons-material/AddCircle';
import ClearIcon from '@mui/icons-material/Clear';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import DownloadIcon from '@mui/icons-material/Download';

import { getUrls } from '../app/utils';
import { apiRequest, ApiError, ApiRequestError } from '../app/apiClient';
import { useTranslation } from 'react-i18next';
import { LogViewerDialog } from './LogViewerDialog';
import { iconVar, textVar } from '../app/layout';


// Add this helper function at the top of the file, after the imports
const simpleHash = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
};

const CONFIGURED_SECRET_MASK = '******';

// This deployment calls exactly one kind of provider: a custom
// OpenAI-compatible endpoint. There is no provider picker because there is
// nothing to pick — the API base URL is what decides where a model lives.
const CUSTOM_ENDPOINT = 'custom';

interface ModelSelectionButtonProps {
    appearance?: 'toolbar' | 'inline';
}

interface RememberedModelEndpoint {
    endpoint: string;
    model: string;
    api_base: string;
    api_version: string;
    auth_mode: string;
}

export const ModelSelectionButton: React.FC<ModelSelectionButtonProps> = ({ appearance = 'toolbar' }) => {
    const { t } = useTranslation();

    const dispatch = useDispatch();
    const globalModels = useSelector((state: DataFormulatorState) => state.globalModels ?? []);
    const models = useSelector((state: DataFormulatorState) => state.models);
    const selectedModelId = useSelector((state: DataFormulatorState) => state.selectedModelId);
    const testedModels = useSelector((state: DataFormulatorState) => state.testedModels);
    const config = useSelector((state: DataFormulatorState) => state.config);

    const [modelDialogOpen, setModelDialogOpen] = useState<boolean>(false);
    const [detailModelId, setDetailModelId] = useState<string | undefined>(selectedModelId);
    const [isEditingDetails, setIsEditingDetails] = useState(false);
    const [showKeys, setShowKeys] = useState<boolean>(false);
    // Model ids already configured on this server, offered as suggestions.
    const [knownModelIds, setKnownModelIds] = useState<string[]>([]);
    // Model ids the endpoint being configured just reported.
    const [fetchedModelIds, setFetchedModelIds] = useState<string[]>([]);
    const [loadingProviderModels, setLoadingProviderModels] = useState(false);
    const [providerModelsMessage, setProviderModelsMessage] = useState<string>("");
    const [providerModelsError, setProviderModelsError] = useState(false);
    const serverConfig = useSelector((state: DataFormulatorState) => state.serverConfig);

    // Which endpoints exist, and with whose credentials, is an operator
    // decision: every model route rejects a non-admin, so the configuration
    // controls are not rendered for one either. Everybody else picks from the
    // models the administrator has already loaded.
    const canConfigure = serverConfig.IS_ADMIN === true && !serverConfig.DISABLE_CUSTOM_MODELS;
    const newEndpoint = CUSTOM_ENDPOINT;

    let updateModelStatus = (model: ModelConfig, status: 'ok' | 'error' | 'testing' | 'unknown', message: string) => {
        dispatch(dfActions.updateModelStatus({id: model.id, status, message}));
    }
    let getStatus = (id: string | undefined) => {
        return id != undefined ? (testedModels.find(t => (t.id == id))?.status || 'unknown') : 'unknown';
    }

    // Helper functions for slot management
    const [tempSelectedModelId, setTempSelectedModelId] = useState<string | undefined>(selectedModelId);
    const [newModel, setNewModel] = useState<string>("");
    const [newApiKey, setNewApiKey] = useState<string>("");
    const [newApiBase, setNewApiBase] = useState<string>("");
    const [newApiVersion, setNewApiVersion] = useState<string>("");
    const [isAddingModel, setIsAddingModel] = useState(false);
    const [newModelError, setNewModelError] = useState("");
    const [newModelDiagnostic, setNewModelDiagnostic] = useState<ApiError | null>(null);
    const [modelLogsOpen, setModelLogsOpen] = useState(false);
    const [rememberedEndpoints, setRememberedEndpoints] = useState<RememberedModelEndpoint[]>([]);

    useEffect(() => {
        if (!modelDialogOpen || !canConfigure) return;
        apiRequest<RememberedModelEndpoint[]>(getUrls().MODEL_ENDPOINTS)
            .then(({ data }) => setRememberedEndpoints(data))
            .catch(() => setRememberedEndpoints([]));
    }, [modelDialogOpen]);

    const rememberModelEndpoint = (model: ModelConfig) => {
        const entry = {
            endpoint: model.endpoint,
            model: model.model,
            api_base: model.api_base || '',
            api_version: model.api_version || '',
            auth_mode: model.auth_mode || '',
        };
        apiRequest<RememberedModelEndpoint>(getUrls().MODEL_ENDPOINTS, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry),
        }).then(() => {
            setRememberedEndpoints(current => [
                entry,
                ...current.filter(existing => JSON.stringify(existing) !== JSON.stringify(entry)),
            ].slice(0, 20));
        }).catch(() => undefined);
    };

    // Model ids already published by the server, offered alongside whatever the
    // endpoint reports so an admin rarely has to type one out.
    useEffect(() => {
        setKnownModelIds(Array.from(new Set(
            globalModels.map((modelConfig: any) => modelConfig.model).filter(Boolean),
        )));
    }, [globalModels]);


    const allModels = [...globalModels, ...models];
    const detailModel = allModels.find(model => model.id === detailModelId);
    const detailIsGlobal = globalModels.some(model => model.id === detailModelId);
    const detailModelStatus = getStatus(detailModelId);
    const detailHasConfiguredApiKey = detailModel
        ? detailIsGlobal
            ? detailModel.auth_mode === 'key'
            : Boolean(detailModel.api_key)
        : false;

    let modelExists = allModels.some(m => m.id !== detailModelId &&
        m.endpoint == newEndpoint && m.model == newModel && m.api_base == newApiBase 
        && (m.api_key || '') == newApiKey && (m.api_version || '') == newApiVersion);

    let testModel = (model: ModelConfig) => {
        updateModelStatus(model, 'testing', "");
        apiRequest(getUrls().TEST_MODEL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
        })
            .then(({ data }) => {
                rememberModelEndpoint(model);
                updateModelStatus(model, 'ok', data.message || "");
                if (!tempSelectedModelId) {
                    setTempSelectedModelId(model.id);
                }
            }).catch((error) => {
                const msg = error instanceof ApiRequestError
                    ? error.apiError.message
                    : error.message;
                updateModelStatus(model, 'error', msg);
            });
    }

    // Whatever the endpoint just told us, plus models already configured here,
    // so both sources are offered in one list.
    const modelOptionsForEndpoint = useMemo(
        () => Array.from(new Set([...fetchedModelIds, ...knownModelIds])),
        [fetchedModelIds, knownModelIds]);

    const handleLoadProviderModels = () => {
        if (loadingProviderModels) return;
        setLoadingProviderModels(true);
        setProviderModelsMessage("");
        setProviderModelsError(false);

        apiRequest<{ models: string[] }>(getUrls().LIST_PROVIDER_MODELS, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: {
                    endpoint: newEndpoint,
                    api_key: newApiKey,
                    api_base: newApiBase,
                    api_version: newApiVersion,
                },
            }),
        }).then(({ data }) => {
            const models = data.models || [];
            setFetchedModelIds(models);
            setProviderModelsMessage(t('model.loadModelsFound', {
                defaultValue: '{{count}} models available — pick one from the list.',
                count: models.length,
            }));
        }).catch((error) => {
            const msg = error instanceof ApiRequestError ? error.apiError.message : error.message;
            setProviderModelsError(true);
            setProviderModelsMessage(msg);
        }).finally(() => {
            setLoadingProviderModels(false);
        });
    };

    // A base URL is the one thing a custom endpoint cannot do without; the
    // key is optional because some internal endpoints take none.
    let readyToTest = newModel && newApiBase && !isAddingModel;

    const resetNewModelForm = () => {
        setNewModel("");
        setNewApiKey("");
        setNewApiBase("");
        setNewApiVersion("");
        setNewModelError("");
        setNewModelDiagnostic(null);
    };

    const handleSaveModel = async () => {
        const updatingUserModel = detailModelId && !detailIsGlobal;
        const id = updatingUserModel
            ? detailModelId
            : simpleHash(`${newEndpoint}-${newModel}-${newApiKey}-${newApiBase}-${newApiVersion}`);
        const model: ModelConfig = {
            endpoint: newEndpoint,
            model: newModel,
            api_key: newApiKey,
            api_base: newApiBase,
            api_version: newApiVersion,
            auth_mode: 'key',
            id,
        };

        setIsAddingModel(true);
        setNewModelError("");
        setNewModelDiagnostic(null);
        updateModelStatus(model, 'testing', "");
        try {
            const { data } = await apiRequest(getUrls().TEST_MODEL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model }),
            });
            rememberModelEndpoint(model);
            dispatch(updatingUserModel ? dfActions.updateModel(model) : dfActions.addModel(model));
            updateModelStatus(model, 'ok', data.message || "");
            setTempSelectedModelId(id);
            setDetailModelId(id);
            setIsEditingDetails(false);
        } catch (error) {
            const message = error instanceof ApiRequestError
                ? error.apiError.message
                : error instanceof Error ? error.message : String(error);
            setNewModelDiagnostic(error instanceof ApiRequestError ? error.apiError : {
                code: 'CLIENT_ERROR',
                message,
                retry: false,
            });
            updateModelStatus(model, 'error', message);
            setNewModelError(message);
        } finally {
            setIsAddingModel(false);
        }
    };

    const loadModelDetails = (model: ModelConfig) => {
        setDetailModelId(model.id);
        setTempSelectedModelId(model.id);
        setNewModel(model.model);
        setNewApiBase(model.api_base || '');
        setNewApiVersion(model.api_version || '');
        setNewApiKey(model.is_global ? '' : model.api_key || '');
        setNewModelError('');
        setNewModelDiagnostic(null);
        setIsEditingDetails(false);
    };

    const startNewModel = () => {
        setDetailModelId(undefined);
        resetNewModelForm();
        // Opening the dialog with no models selected must not drop a non-admin
        // into a form the server would refuse to save.
        setIsEditingDetails(canConfigure);
    };

    const editModelDetails = () => {
        setIsEditingDetails(true);
    };

    const copyModelDetails = () => {
        setDetailModelId(undefined);
        setNewModelError('');
        setIsEditingDetails(true);
    };

    const inputSx = {
        '& .MuiOutlinedInput-root': {
            fontSize: '0.75rem',
            borderRadius: 0.5,
            backgroundColor: 'rgba(0,0,0,0.02)',
            height: 28,
            '& fieldset': { borderColor: 'divider' },
            '&:hover fieldset': { borderColor: 'text.disabled' },
            '&.Mui-focused fieldset': { borderColor: 'primary.main' },
        },
        '& .MuiOutlinedInput-input': { px: 1, py: 0 },
    };

    const addModelForm = (
        <Box sx={{ display: 'grid', gap: 2 }}>
            {isEditingDetails && rememberedEndpoints.length > 0 && (
                <Autocomplete
                    size="small"
                    options={rememberedEndpoints}
                    value={null}
                    getOptionLabel={(option) => option.model}
                    renderOption={(props, option) => (
                        <li {...props} key={`${option.model}-${option.api_base}-${option.api_version}`}>
                            <Box sx={{ minWidth: 0 }}>
                                <Typography variant="body2">{option.model}</Typography>
                                {option.api_base && (
                                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                                        {option.api_base}
                                    </Typography>
                                )}
                            </Box>
                        </li>
                    )}
                    onChange={(_event, option) => {
                        if (!option) return;
                        setNewModel(option.model);
                        setNewApiBase(option.api_base);
                        setNewApiVersion(option.api_version);
                        setNewApiKey('');
                        setNewModelError('');
                        setNewModelDiagnostic(null);
                    }}
                    renderInput={(params) => (
                        <TextField {...params} label={t('model.recentConfigurations')} />
                    )}
                />
            )}
            {(isEditingDetails || Boolean(newApiBase)) && (
                <TextField
                    fullWidth
                    size="small"
                    disabled={!isEditingDetails}
                    label={t('model.apiBase')}
                    value={newApiBase}
                    onChange={(event) => setNewApiBase(event.target.value)}
                    placeholder="https://your-gateway.example.com/v1"
                    helperText={isEditingDetails
                        ? t('model.apiBaseHint', {
                            defaultValue: 'The OpenAI-compatible base URL. /chat/completions is appended for you.',
                        })
                        : undefined}
                    autoComplete="off"
                />
            )}

            {(isEditingDetails || detailHasConfiguredApiKey) && (
                <TextField
                    fullWidth
                    size="small"
                    disabled={!isEditingDetails}
                    type={isEditingDetails && !showKeys ? 'password' : 'text'}
                    label={t('model.apiKey')}
                    value={isEditingDetails ? newApiKey : CONFIGURED_SECRET_MASK}
                    onChange={(event) => setNewApiKey(event.target.value)}
                    helperText={isEditingDetails
                        ? t('model.apiKeyHint', {
                            defaultValue: 'Leave blank only if the endpoint takes no key — a blank key against one that needs it comes back as a 401.',
                        })
                        : undefined}
                    autoComplete="off"
                />
            )}

            {/* Model picker: type an id, or pull the list from the endpoint.
                Kept free-solo so a model the provider doesn't advertise (a
                private deployment, a brand-new release) can still be entered. */}
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                <Autocomplete
                    freeSolo
                    fullWidth
                    size="small"
                    disabled={!isEditingDetails}
                    options={modelOptionsForEndpoint}
                    value={newModel}
                    inputValue={newModel}
                    onInputChange={(_event, value) => setNewModel(value)}
                    renderInput={(params) => (
                        <TextField
                            {...params}
                            label={t('model.model')}
                            placeholder={t('model.modelPlaceholder')}
                            autoComplete="off"
                        />
                    )}
                />
                <Tooltip title={t('model.loadModelsHint', {
                    defaultValue: 'Fetch the models this endpoint offers',
                })}>
                    <span>
                        <Button
                            size="small"
                            variant="outlined"
                            disabled={!isEditingDetails || !newApiBase || loadingProviderModels}
                            onClick={handleLoadProviderModels}
                            startIcon={loadingProviderModels
                                ? <CircularProgress size={iconVar.sm} />
                                : <DownloadIcon sx={{ fontSize: iconVar.md }} />}
                            sx={{ textTransform: 'none', whiteSpace: 'nowrap', mt: 0.25 }}
                        >
                            {t('model.loadModels', { defaultValue: 'Load models' })}
                        </Button>
                    </span>
                </Tooltip>
            </Box>
            {providerModelsMessage && (
                <Typography sx={{ fontSize: textVar.sm, color: providerModelsError ? 'error.main' : 'text.secondary', mt: -0.5 }}>
                    {providerModelsMessage}
                </Typography>
            )}

            {(isEditingDetails || Boolean(newApiVersion)) && (
                <Accordion disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'divider', '&:before': { display: 'none' } }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Typography variant="body2">{t('model.advancedSettings')}</Typography>
                    </AccordionSummary>
                    <AccordionDetails>
                        <TextField
                            fullWidth
                            size="small"
                            disabled={!isEditingDetails}
                            label={t('model.apiVersion')}
                            value={newApiVersion}
                            onChange={(event) => setNewApiVersion(event.target.value)}
                            autoComplete="off"
                        />
                    </AccordionDetails>
                </Accordion>
            )}

            {isEditingDetails && modelExists && <Typography variant="caption" color="error">{t('model.providerModelExists')}</Typography>}
            {newModelDiagnostic && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography variant="caption" color="error" sx={{ flex: 1 }}>
                        {newModelError}
                    </Typography>
                    <Tooltip title={t('model.copyDiagnostic')}>
                        <IconButton
                            size="small"
                            aria-label={t('model.copyDiagnostic')}
                            onClick={() => navigator.clipboard.writeText([
                                newModelDiagnostic.message,
                                newModelDiagnostic.request_id || '',
                            ].filter(Boolean).join('\n'))}
                        >
                            <ContentCopyOutlinedIcon fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    {serverConfig.IS_LOCAL_MODE && (
                        <Button
                            size="small"
                            variant="text"
                            startIcon={<TerminalOutlinedIcon />}
                            onClick={() => setModelLogsOpen(true)}
                            sx={{ whiteSpace: 'nowrap' }}
                        >
                            {t('model.viewRecentLog')}
                        </Button>
                    )}
                </Box>
            )}
            <LogViewerDialog
                open={modelLogsOpen}
                onOpenChange={setModelLogsOpen}
                hideTrigger
                tailLines={100}
                title={t('model.recentLog')}
            />
        </Box>
    );

    // What a non-admin sees in place of the configuration form: the facts that
    // identify the model, and nothing that could change it. The API key is not
    // among them — it is never sent to the browser for a server model anyway.
    const readOnlyModelDetails = (
        <Box sx={{ display: 'grid', gap: 1.5 }}>
            {detailModel ? (
                <>
                    <Box>
                        <Typography variant="caption" color="text.secondary">{t('model.model')}</Typography>
                        <Typography variant="body2">{detailModel.model}</Typography>
                    </Box>
                    {detailModel.api_base && (
                        <Box>
                            <Typography variant="caption" color="text.secondary">{t('model.apiBase')}</Typography>
                            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{detailModel.api_base}</Typography>
                        </Box>
                    )}
                    <Typography variant="caption" color="text.secondary">
                        {t('model.adminManagedDetail', {
                            defaultValue: 'Configured by your administrator. Contact them to add or change a model.',
                        })}
                    </Typography>
                </>
            ) : (
                <Typography variant="body2" color="text.secondary">
                    {t('model.noModelsConfigured', {
                        defaultValue: 'No models are configured on this server yet. Your administrator sets them up.',
                    })}
                </Typography>
            )}
        </Box>
    );

    const modelManagerView = (
        <Box sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'minmax(220px, 0.75fr) minmax(380px, 1.4fr)' },
            gap: 3,
            py: 1,
        }}>
            <Box sx={{ pr: { md: 2.5 }, borderRight: { md: '1px solid' }, borderColor: { md: 'divider' } }}>
                <Box sx={{ display: 'grid' }}>
                    {allModels.map(model => (
                            <Box
                                key={model.id}
                                onClick={() => loadModelDetails(model)}
                                sx={{
                                    display: 'grid',
                                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                                    alignItems: 'center',
                                    gap: 1,
                                    px: 1,
                                    py: 1.25,
                                    borderBottom: '1px solid',
                                    borderColor: 'divider',
                                    bgcolor: detailModelId === model.id ? 'action.selected' : 'transparent',
                                    cursor: 'pointer',
                                    '&:hover': { bgcolor: 'action.hover' },
                                }}
                            >
                                <Box sx={{ minWidth: 0 }}>
                                    <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>{model.model}</Typography>
                                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                                        {model.api_base || t('model.apiBase')}
                                    </Typography>
                                </Box>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    {selectedModelId === model.id && (
                                        <Typography variant="caption" color="text.secondary">
                                            {t('model.current')}
                                        </Typography>
                                    )}
                                    {canConfigure && !globalModels.some(globalModel => globalModel.id === model.id) && (
                                        <Tooltip title={t('model.removeModel')}>
                                            <IconButton
                                                size="small"
                                                aria-label={t('model.removeModel')}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    dispatch(dfActions.removeModel(model.id));
                                                    if (detailModelId === model.id) {
                                                        const fallback = allModels.find(candidate => candidate.id !== model.id);
                                                        if (fallback) loadModelDetails(fallback);
                                                        else startNewModel();
                                                    }
                                                }}
                                            >
                                                <ClearIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    )}
                                </Box>
                            </Box>
                    ))}
                    {canConfigure ? (
                        <Button
                            size="small"
                            startIcon={<AddCircleIcon />}
                            onClick={startNewModel}
                            variant={detailModelId === undefined && isEditingDetails ? 'soft' : 'text'}
                            sx={{
                                justifyContent: 'flex-start',
                                mt: 1,
                            }}
                        >
                            {t('model.addModel')}
                        </Button>
                    ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, px: 1 }}>
                            {t('model.adminManaged', {
                                defaultValue: 'Your administrator configures the models available here.',
                            })}
                        </Typography>
                    )}
                </Box>
            </Box>
            <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                    <Box>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                            {detailModel ? detailModel.model : t('model.newModel')}
                        </Typography>
                        {detailIsGlobal && (
                            <Typography variant="caption" color="text.secondary">{t('model.serverManaged')}</Typography>
                        )}
                    </Box>
                    {!isEditingDetails && detailModel && canConfigure && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Button
                                size="small"
                                variant="outlined"
                                color={detailModelStatus === 'ok' ? 'success' : detailModelStatus === 'error' ? 'error' : 'primary'}
                                disabled={detailModelStatus === 'testing'}
                                startIcon={detailModelStatus === 'testing'
                                    ? <CircularProgress size={iconVar.sm} color="inherit" />
                                    : detailModelStatus === 'ok'
                                        ? <CheckCircleOutlineIcon />
                                        : detailModelStatus === 'error'
                                            ? <ErrorOutlineIcon />
                                            : <PlayCircleOutlineIcon />}
                                onClick={() => testModel(detailModel)}
                            >
                                {detailModelStatus === 'testing'
                                    ? t('model.testing')
                                    : detailModelStatus === 'ok'
                                        ? t('model.testPassed')
                                        : detailModelStatus === 'error'
                                            ? t('model.testFailedRetry')
                                            : t('model.testModel')}
                            </Button>
                            {detailIsGlobal ? (
                                <Button
                                    size="small"
                                    variant="text"
                                    startIcon={<ContentCopyOutlinedIcon />}
                                    onClick={copyModelDetails}
                                >
                                    {t('model.copyDetails')}
                                </Button>
                            ) : (
                                <Button size="small" variant="text" onClick={editModelDetails}>
                                    {t('model.edit')}
                                </Button>
                            )}
                        </Box>
                    )}
                </Box>
                {canConfigure ? addModelForm : readOnlyModelDetails}
            </Box>
        </Box>
    );

    // A model is "ready" to use when it's been verified ('ok') or when it's a
    // server-configured model in 'unknown' state (trusted by default).
    const isModelReady = (id: string | undefined): boolean => {
        if (!id) return false;
        const status = getStatus(id);
        if (status === 'ok') return true;
        const isGlobal = globalModels.some(m => m.id === id);
        return isGlobal && status === 'unknown';
    };

    let modelNotReady = !isModelReady(tempSelectedModelId);

    let tempModel = allModels.find(m => m.id == tempSelectedModelId);
    let tempModelName = tempModel ? tempModel.model : t('model.pleaseSelectModel');
    let selectedModelName = allModels.find(m => m.id == selectedModelId)?.model || t('model.unselected');

    const selectedReady = isModelReady(selectedModelId);
    const isInlineAction = appearance === 'inline';

    return <>
        <Tooltip title={t('model.selectModel')}>
            <Button
                sx={{
                    fontSize: isInlineAction ? 'inherit' : '13px',
                    fontWeight: 400,
                    textTransform: 'none',
                    px: 1.5,
                    py: 0.5,
                    minWidth: 'auto',
                    lineHeight: 1.5,
                    color: selectedReady ? 'text.secondary' : undefined,
                    '&:hover': {
                        color: selectedReady ? 'text.primary' : undefined,
                        backgroundColor: 'rgba(0, 0, 0, 0.04)',
                    },
                }}
                variant="text"
                color={selectedReady ? 'inherit' : 'warning'}
                onClick={() => {
                    const initialModel = allModels.find(model => model.id === selectedModelId) || allModels[0];
                    if (initialModel) loadModelDetails(initialModel);
                    else startNewModel();
                    setModelDialogOpen(true);
                }}
            >
                {selectedReady ? selectedModelName : t('model.selectModels')}
            </Button>
        </Tooltip>
        <Dialog 
            maxWidth="lg" 
            open={modelDialogOpen}
            onClose={() => {
                if (!isAddingModel) setModelDialogOpen(false);
            }}
        >
            <DialogTitle>{t('model.models')}</DialogTitle>
            <DialogContent sx={{ minWidth: { sm: 720 } }}>{modelManagerView}</DialogContent>
            <DialogActions>
                {isEditingDetails && canConfigure ? (
                    <>
                        {!serverConfig.DISABLE_DISPLAY_KEYS && (
                            <FormControlLabel
                                control={<Switch size="small" checked={showKeys} onChange={() => setShowKeys(!showKeys)} />}
                                label={<Typography variant="body2">{t('model.showKeys')}</Typography>}
                            />
                        )}
                        <Button variant="text" disabled={isAddingModel} onClick={() => {
                            if (detailModel) loadModelDetails(detailModel);
                            else {
                                const initialModel = allModels.find(model => model.id === selectedModelId) || allModels[0];
                                if (initialModel) loadModelDetails(initialModel);
                            }
                        }}>{t('model.cancel')}</Button>
                        <Button
                            variant="contained"
                            disabled={!readyToTest || modelExists}
                            onClick={handleSaveModel}
                            startIcon={isAddingModel ? <CircularProgress size={iconVar.md} color="inherit" /> : undefined}
                        >
                            {isAddingModel ? t('model.testing') : t('model.testAndSave')}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button variant="text" onClick={() => setModelDialogOpen(false)}>{t('model.cancel')}</Button>
                        <Button
                            variant="contained"
                            disabled={modelNotReady}
                            onClick={() => {
                                dispatch(dfActions.selectModel(tempSelectedModelId));
                                setModelDialogOpen(false);
                            }}
                        >
                            {t('model.useModel', { modelName: tempModelName })}
                        </Button>
                    </>
                )}
            </DialogActions>
        </Dialog>
    </>;
}
