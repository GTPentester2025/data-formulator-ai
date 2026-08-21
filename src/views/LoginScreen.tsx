/**
 * LoginScreen — the gate in front of the whole app when accounts are enabled.
 *
 * It also handles the first-sign-in case: an account created or reset by an
 * administrator arrives with a password somebody else chose, so the owner is
 * asked to replace it before the app opens.
 */

import { FC, FormEvent, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Paper,
    TextField,
    Typography,
    useTheme,
    alpha,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { textVar } from '../app/layout';
import { toolName } from '../app/App';
import { changeOwnPassword, signIn, type LocalUser } from '../app/localAuth';
import { ApiRequestError } from '../app/apiClient';

const errorMessage = (error: unknown): string =>
    error instanceof ApiRequestError
        ? error.apiError.message
        : (error instanceof Error ? error.message : String(error));

export const LoginScreen: FC<{ onSignedIn: (user: LocalUser) => void }> = ({ onSignedIn }) => {
    const theme = useTheme();
    const { t } = useTranslation();

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Set once a sign-in succeeds but the account still owes us a new password.
    const [pendingUser, setPendingUser] = useState<LocalUser | null>(null);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');

    const handleSignIn = async (event: FormEvent) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const user = await signIn(username.trim(), password);
            if (user.must_change_password) {
                setPendingUser(user);
            } else {
                onSignedIn(user);
            }
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const handleChangePassword = async (event: FormEvent) => {
        event.preventDefault();
        if (busy || !pendingUser) return;
        if (newPassword !== confirmPassword) {
            setError(t('auth.passwordsDoNotMatch', { defaultValue: 'The two passwords do not match' }));
            return;
        }
        setBusy(true);
        setError('');
        try {
            const user = await changeOwnPassword(password, newPassword);
            onSignedIn(user);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const changing = pendingUser !== null;

    return (
        <Box
            component="main"
            sx={{
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                px: 2,
                background: `
                    linear-gradient(90deg, ${alpha(theme.palette.text.secondary, 0.02)} 1px, transparent 1px),
                    linear-gradient(0deg, ${alpha(theme.palette.text.secondary, 0.02)} 1px, transparent 1px)
                `,
                backgroundSize: '16px 16px',
            }}
        >
            <Paper
                variant="outlined"
                sx={{ width: '100%', maxWidth: 380, p: 4, borderRadius: 2 }}
                component="form"
                onSubmit={changing ? handleChangePassword : handleSignIn}
            >
                <Typography component="h1" sx={{ fontSize: 34, letterSpacing: '0.04em', mb: 0.5 }}>
                    {toolName}
                </Typography>
                <Typography sx={{ fontSize: textVar.md, color: 'text.secondary', mb: 3 }}>
                    {changing
                        ? t('auth.chooseNewPassword', { defaultValue: 'Choose a new password to continue.' })
                        : t('auth.signInPrompt', { defaultValue: 'Sign in to continue.' })}
                </Typography>

                {error && (
                    <Alert severity="error" sx={{ mb: 2, fontSize: textVar.sm }}>{error}</Alert>
                )}

                {!changing && (
                    <>
                        <TextField
                            fullWidth
                            size="small"
                            autoFocus
                            label={t('auth.username', { defaultValue: 'Username' })}
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            autoComplete="username"
                            sx={{ mb: 2 }}
                        />
                        <TextField
                            fullWidth
                            size="small"
                            type="password"
                            label={t('auth.password', { defaultValue: 'Password' })}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            autoComplete="current-password"
                            sx={{ mb: 3 }}
                        />
                    </>
                )}

                {changing && (
                    <>
                        <TextField
                            fullWidth
                            size="small"
                            autoFocus
                            type="password"
                            label={t('auth.newPassword', { defaultValue: 'New password' })}
                            value={newPassword}
                            onChange={e => setNewPassword(e.target.value)}
                            autoComplete="new-password"
                            sx={{ mb: 2 }}
                        />
                        <TextField
                            fullWidth
                            size="small"
                            type="password"
                            label={t('auth.confirmPassword', { defaultValue: 'Confirm new password' })}
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            autoComplete="new-password"
                            sx={{ mb: 3 }}
                        />
                    </>
                )}

                <Button
                    type="submit"
                    fullWidth
                    variant="contained"
                    disabled={busy || (changing ? !newPassword : !username || !password)}
                    startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
                    sx={{ textTransform: 'none' }}
                >
                    {changing
                        ? t('auth.savePassword', { defaultValue: 'Save password' })
                        : t('auth.signIn', { defaultValue: 'Sign in' })}
                </Button>
            </Paper>
        </Box>
    );
};
