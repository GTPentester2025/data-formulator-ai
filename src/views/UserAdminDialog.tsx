/**
 * UserAdminDialog — account management for administrators.
 *
 * Deliberately limited to accounts: an administrator can add people, reset a
 * forgotten password, change a role, or remove someone. They cannot open
 * anyone else's workspaces or sessions, because nothing here grants access to
 * another account's data.
 *
 * Passwords set here are shown once, at the moment they are set, since the
 * server only ever stores their hash.
 */

import { FC, useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    MenuItem,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LockResetIcon from '@mui/icons-material/LockReset';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useTranslation } from 'react-i18next';
import { textVar, iconVar } from '../app/layout';
import { ApiRequestError } from '../app/apiClient';
import {
    createUser,
    deleteUser,
    listUsers,
    resetUserPassword,
    setUserRole,
    suggestPassword,
    type LocalUser,
} from '../app/localAuth';

const errorMessage = (error: unknown): string =>
    error instanceof ApiRequestError
        ? error.apiError.message
        : (error instanceof Error ? error.message : String(error));

interface UserAdminDialogProps {
    open: boolean;
    onClose: () => void;
    currentUsername: string;
}

export const UserAdminDialog: FC<UserAdminDialogProps> = ({ open, onClose, currentUsername }) => {
    const { t } = useTranslation();

    const [users, setUsers] = useState<LocalUser[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState<'admin' | 'user'>('user');

    // The one-time password to show after creating an account or resetting one.
    const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setUsers(await listUsers());
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (open) {
            refresh();
            setIssued(null);
            setNewUsername('');
            setNewPassword(suggestPassword());
            setNewRole('user');
        }
    }, [open, refresh]);

    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            await action();
            await refresh();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const handleCreate = () => run(async () => {
        await createUser(newUsername.trim(), newPassword, newRole);
        setIssued({ username: newUsername.trim().toLowerCase(), password: newPassword });
        setNewUsername('');
        setNewPassword(suggestPassword());
    });

    const handleReset = (username: string) => run(async () => {
        const password = suggestPassword();
        await resetUserPassword(username, password);
        setIssued({ username, password });
    });

    const handleDelete = (username: string) => run(async () => {
        await deleteUser(username);
        setIssued(null);
    });

    const handleRole = (username: string, role: 'admin' | 'user') =>
        run(() => setUserRole(username, role));

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle sx={{ fontSize: textVar.lg, fontWeight: 600 }}>
                {t('admin.title', { defaultValue: 'Users' })}
            </DialogTitle>
            <DialogContent>
                <Typography sx={{ fontSize: textVar.sm, color: 'text.secondary', mb: 2 }}>
                    {t('admin.intro', {
                        defaultValue: 'Each account keeps its own data. Administrators manage accounts here but cannot open anyone else’s workspaces.',
                    })}
                </Typography>

                {error && <Alert severity="error" sx={{ mb: 2, fontSize: textVar.sm }}>{error}</Alert>}

                {issued && (
                    <Alert severity="info" sx={{ mb: 2, fontSize: textVar.sm }}
                        action={
                            <Tooltip title={t('admin.copyPassword', { defaultValue: 'Copy password' })}>
                                <IconButton size="small" onClick={() => navigator.clipboard?.writeText(issued.password)}>
                                    <ContentCopyIcon sx={{ fontSize: iconVar.md }} />
                                </IconButton>
                            </Tooltip>
                        }>
                        {t('admin.passwordIssued', {
                            defaultValue: 'Password for {{username}}: {{password}} — give it to them now; it cannot be shown again.',
                            username: issued.username,
                            password: issued.password,
                        })}
                    </Alert>
                )}

                {/* Add an account */}
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 3, flexWrap: 'wrap' }}>
                    <TextField
                        size="small"
                        label={t('auth.username', { defaultValue: 'Username' })}
                        value={newUsername}
                        onChange={e => setNewUsername(e.target.value)}
                        sx={{ flex: '1 1 160px' }}
                    />
                    <TextField
                        size="small"
                        label={t('admin.initialPassword', { defaultValue: 'Initial password' })}
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        sx={{ flex: '1 1 220px' }}
                    />
                    <TextField
                        select
                        size="small"
                        label={t('admin.role', { defaultValue: 'Role' })}
                        value={newRole}
                        onChange={e => setNewRole(e.target.value as 'admin' | 'user')}
                        sx={{ width: 130 }}
                    >
                        <MenuItem value="user">{t('admin.roleUser', { defaultValue: 'user' })}</MenuItem>
                        <MenuItem value="admin">{t('admin.roleAdmin', { defaultValue: 'admin' })}</MenuItem>
                    </TextField>
                    <Button
                        variant="contained"
                        size="small"
                        disabled={busy || !newUsername.trim() || !newPassword}
                        onClick={handleCreate}
                        sx={{ textTransform: 'none', mt: 0.25 }}
                    >
                        {t('admin.addUser', { defaultValue: 'Add user' })}
                    </Button>
                </Box>

                {loading ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                        <CircularProgress size={20} />
                    </Box>
                ) : (
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>{t('auth.username', { defaultValue: 'Username' })}</TableCell>
                                <TableCell>{t('admin.role', { defaultValue: 'Role' })}</TableCell>
                                <TableCell>{t('admin.lastLogin', { defaultValue: 'Last sign-in' })}</TableCell>
                                <TableCell align="right">{t('admin.actions', { defaultValue: 'Actions' })}</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {users.map(user => (
                                <TableRow key={user.username}>
                                    <TableCell sx={{ fontSize: textVar.md }}>
                                        {user.username}
                                        {user.username === currentUsername && (
                                            <Typography component="span" sx={{ fontSize: textVar.sm, color: 'text.secondary', ml: 1 }}>
                                                {t('admin.you', { defaultValue: '(you)' })}
                                            </Typography>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <TextField
                                            select
                                            size="small"
                                            variant="standard"
                                            value={user.role}
                                            disabled={busy}
                                            onChange={e => handleRole(user.username, e.target.value as 'admin' | 'user')}
                                            sx={{ width: 100 }}
                                        >
                                            <MenuItem value="user">{t('admin.roleUser', { defaultValue: 'user' })}</MenuItem>
                                            <MenuItem value="admin">{t('admin.roleAdmin', { defaultValue: 'admin' })}</MenuItem>
                                        </TextField>
                                    </TableCell>
                                    <TableCell sx={{ fontSize: textVar.sm, color: 'text.secondary' }}>
                                        {user.last_login_at
                                            ? new Date(user.last_login_at).toLocaleString()
                                            : t('admin.never', { defaultValue: 'never' })}
                                    </TableCell>
                                    <TableCell align="right">
                                        <Tooltip title={t('admin.resetPassword', { defaultValue: 'Reset password' })}>
                                            <span>
                                                <IconButton size="small" disabled={busy}
                                                    onClick={() => handleReset(user.username)}>
                                                    <LockResetIcon sx={{ fontSize: iconVar.lg }} />
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                        <Tooltip title={user.username === currentUsername
                                            ? t('admin.cannotDeleteSelf', { defaultValue: 'You cannot delete your own account' })
                                            : t('admin.deleteUser', { defaultValue: 'Delete user and all their data' })}>
                                            <span>
                                                <IconButton size="small" color="error"
                                                    disabled={busy || user.username === currentUsername}
                                                    onClick={() => handleDelete(user.username)}>
                                                    <DeleteOutlineIcon sx={{ fontSize: iconVar.lg }} />
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </DialogContent>
            <DialogActions>
                <Button size="small" onClick={onClose} sx={{ textTransform: 'none' }}>
                    {t('export.cancel', { defaultValue: 'Close' })}
                </Button>
            </DialogActions>
        </Dialog>
    );
};
