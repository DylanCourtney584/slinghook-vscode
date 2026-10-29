import { createSseParser } from './shared/sse.js';

const MAX_BACKOFF_MS = 30_000;

export class StreamAuthError extends Error {}

/**
 * Follows one endpoint's event stream until `signal` aborts, the token is
 * refused, or the endpoint is gone.
 *
 * The server sends the newest 50 events as `history` on a fresh connection,
 * then `log` for each new one, and closes the stream every ~55s by design. We
 * reconnect with Last-Event-ID so nothing is missed or repeated.
 *
 * @param {object} opts
 * @param {string} opts.server
 * @param {string} opts.token
 * @param {string} opts.endpointUuid
 * @param {(log: object, info: {live: boolean}) => void} opts.onEvent   live is false for the backlog
 * @param {(status: 'connecting'|'live'|'reconnecting', detail?: string) => void} [opts.onStatus]
 * @param {AbortSignal} opts.signal
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [opts.sleep]
 * @returns {Promise<void>} Rejects with StreamAuthError on 401, or Error when the endpoint is gone
 */
export async function followEndpoint({ server, token, endpointUuid, onEvent, onStatus = () => {}, signal, fetchImpl = fetch, sleep = abortableSleep }) {
    let lastEventId = null;
    let backoffMs = 1_000;
    // Only the first connection's history is backlog. A later connection
    // without an id (the endpoint was empty) gets history that is all new.
    let primed = false;

    onStatus('connecting');
    while (!signal.aborted) {
        let res;
        try {
            const headers = { Accept: 'text/event-stream', Authorization: `Bearer ${token}` };
            if (lastEventId) headers['Last-Event-ID'] = lastEventId;
            res = await fetchImpl(`${server}/v1/events/${endpointUuid}`, { headers, signal });
        } catch (err) {
            if (signal.aborted) return;
            onStatus('reconnecting', err.cause?.message || err.message);
            await sleep(backoffMs, signal);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            continue;
        }

        if (res.status === 401) throw new StreamAuthError('Your SlingHook sign-in has expired.');
        if (res.status === 400 || res.status === 403 || res.status === 404) {
            throw new Error('This endpoint was not found in your workspace.');
        }
        if (!res.ok || !res.body) {
            onStatus('reconnecting', `HTTP ${res.status}`);
            await sleep(backoffMs, signal);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            continue;
        }

        backoffMs = 1_000;
        onStatus('live');
        const isFirstConnection = !primed;
        primed = true;

        const parser = createSseParser((evt) => {
            if (evt.id) lastEventId = evt.id;
            if (evt.event !== 'log' && evt.event !== 'history') return;
            let log;
            try {
                log = JSON.parse(evt.data);
            } catch {
                return;
            }
            onEvent(log, { live: evt.event === 'log' || !isFirstConnection });
        });

        try {
            const decoder = new TextDecoder();
            for await (const chunk of res.body) {
                parser.push(decoder.decode(chunk, { stream: true }));
            }
        } catch (err) {
            if (signal.aborted) return;
            onStatus('reconnecting', err.message);
        }
    }
}

function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
