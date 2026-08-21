// Client for the built-in account system (AUTH_PROVIDER=local).
//
// Every call goes to this app's own server and relies on the session cookie
// it sets, so there is no token to store in the browser.

import { apiRequest } from './apiClient';

export interface LocalUser {
    username: string;
    role: 'admin' | 'user';
    created_at: string;
    last_login_at: string | null;
    must_change_password: boolean;
}

export interface LocalAuthStatus {
    authenticated: boolean;
    user?: LocalUser;
}

const BASE = '/api/auth/local';

export const fetchAuthStatus = async (): Promise<LocalAuthStatus> => {
    const { data } = await apiRequest<LocalAuthStatus>(`${BASE}/status`);
    return data;
};

export const signIn = async (username: string, password: string): Promise<LocalUser> => {
    const { data } = await apiRequest<LocalAuthStatus>(`${BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    return data.user as LocalUser;
};

export const signOut = async (): Promise<void> => {
    await apiRequest(`${BASE}/logout`, { method: 'POST' });
};

export const changeOwnPassword = async (
    currentPassword: string, newPassword: string,
): Promise<LocalUser> => {
    const { data } = await apiRequest<{ user: LocalUser }>(`${BASE}/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    return data.user;
};

// --- administration (rejected by the server unless you are an admin) ----

export const listUsers = async (): Promise<LocalUser[]> => {
    const { data } = await apiRequest<{ users: LocalUser[] }>(`${BASE}/users`);
    return data.users;
};

export const createUser = async (
    username: string, password: string, role: 'admin' | 'user',
): Promise<LocalUser> => {
    const { data } = await apiRequest<{ user: LocalUser }>(`${BASE}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role, must_change_password: true }),
    });
    return data.user;
};

export const resetUserPassword = async (username: string, password: string): Promise<void> => {
    await apiRequest(`${BASE}/users/${encodeURIComponent(username)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, must_change_password: true }),
    });
};

export const setUserRole = async (username: string, role: 'admin' | 'user'): Promise<void> => {
    await apiRequest(`${BASE}/users/${encodeURIComponent(username)}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
    });
};

export const deleteUser = async (username: string): Promise<void> => {
    await apiRequest(`${BASE}/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
};

/** Suggest a strong initial password for an account an admin is creating. */
export const suggestPassword = (): string => {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const values = new Uint32Array(16);
    crypto.getRandomValues(values);
    return Array.from(values, v => alphabet[v % alphabet.length]).join('');
};
