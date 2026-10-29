import { createApi } from './shared/api.js';

/**
 * Browser sign-in, the same flow as `shk auth login`: the server issues a
 * one-time code, the person approves it in the dashboard (signing in however
 * they normally do, 2FA included), and polling then returns a new API token.
 *
 * @param {object} opts
 * @param {string} opts.server
 * @param {string} opts.clientName    Shown on the approval page and the token list, e.g. "VS Code on dev-box"
 * @param {(info: {userCode: string, url: string, urlWithCode: string}) => Promise<void>|void} opts.onCode
 * @param {() => boolean} [opts.isCancelled]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{token: string, email: ?string} | null>} null when cancelled
 */
export async function signInWithBrowser({ server, clientName, onCode, isCancelled = () => false, fetchImpl = fetch, sleep = defaultSleep }) {
    const api = createApi({ server, fetchImpl });
    const start = await api.post('/api/cli/login/start', { client_name: clientName });

    await onCode({
        userCode: start.user_code,
        url: start.verification_uri,
        urlWithCode: start.verification_uri_complete ?? start.verification_uri
    });

    let intervalMs = Math.max(1, Number(start.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;

    while (Date.now() < deadline) {
        await sleep(intervalMs);
        if (isCancelled()) return null;
        try {
            const done = await api.post('/api/cli/login/poll', { device_code: start.device_code });
            return { token: done.token, email: done.user?.email ?? null };
        } catch (err) {
            if (err.message === 'authorization_pending') continue;
            if (err.message === 'slow_down') {
                intervalMs += 5000;
                continue;
            }
            if (err.message === 'access_denied') throw new Error('The sign-in was cancelled in the browser.');
            if (err.message === 'expired_token') throw new Error('The code expired. Sign in again.');
            if (err.message === 'token_limit') throw new Error('You have too many API tokens. Revoke an unused one under User Settings > API Tokens.');
            throw err;
        }
    }

    throw new Error('The code expired. Sign in again.');
}

/**
 * The signed-in person, or null when the token is no longer valid.
 * Other failures (server down, no network) throw, so a token isn't thrown away over a blip.
 */
export async function fetchMe({ server, token, fetchImpl = fetch }) {
    try {
        const data = await createApi({ server, token, fetchImpl }).get('/api/me');
        return data?.user ?? null;
    } catch (err) {
        if (err.status === 401) return null;
        throw err;
    }
}

/**
 * The server URL as typed, tidied: https:// added when no scheme was given,
 * trailing slashes and any path after /app removed.
 *
 * @returns {string|null} null when it isn't an http(s) URL
 */
export function normalizeServer(input) {
    let text = String(input ?? '').trim();
    if (text === '') return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const path = url.pathname.replace(/\/app(\/.*)?$/, '').replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
}

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
