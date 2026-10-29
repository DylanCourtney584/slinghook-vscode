import { createServer } from 'node:http';

/**
 * A tiny stand-in for the SlingHook API: just the routes the extension
 * uses, with the same shapes the real server sends.
 */
export async function startFakeSlingHook({ token = 'shk_test', endpoints = [sampleEndpoint()], logs = [sampleLog()] } = {}) {
    const state = {
        token,
        endpoints,
        logs,
        replays: [],
        streams: [],
        logins: new Map(),
        requests: []
    };

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const body = await readBody(req);
        state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
        const json = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };

        if (url.pathname === '/api/cli/login/start' && req.method === 'POST') {
            const input = JSON.parse(body || '{}');
            state.logins.set('dev123', { clientName: input.client_name, polls: 0 });
            return json(200, {
                device_code: 'dev123',
                user_code: 'BCDF-GHJK',
                verification_uri: `http://${req.headers.host}/app/?device`,
                verification_uri_complete: `http://${req.headers.host}/app/?device=BCDF-GHJK`,
                expires_in: 900,
                interval: 1
            });
        }
        if (url.pathname === '/api/cli/login/poll' && req.method === 'POST') {
            const login = state.logins.get(JSON.parse(body || '{}').device_code);
            if (!login) return json(400, { error: 'expired_token' });
            login.polls++;
            if (login.polls < 2) return json(400, { error: 'authorization_pending' });
            return json(200, { token: state.token, user: { email: 'dev@example.com' } });
        }

        if (req.headers.authorization !== `Bearer ${state.token}`) return json(401, { error: 'Unauthorized' });

        if (url.pathname === '/api/me') {
            return json(200, { user: { email: 'dev@example.com', workspace: { role: 'owner' } } });
        }
        if (url.pathname === '/api/endpoints') return json(200, { endpoints: state.endpoints });

        const stream = url.pathname.match(/^\/v1\/events\/([0-9a-f-]+)$/);
        if (stream) {
            const ep = state.endpoints.find((e) => e.uuid === stream[1]);
            if (!ep) return json(403, { error: 'Forbidden' });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const lastId = Number(req.headers['last-event-id'] ?? 0);
            if (!lastId) {
                for (const log of state.logs.filter((l) => l.endpoint_id === ep.id)) {
                    res.write(`id: ${log.id}\nevent: history\ndata: ${JSON.stringify(log)}\n\n`);
                }
            }
            res.write('event: ready\ndata: {}\n\n');
            state.streams.push({ res, endpointId: ep.id });
            res.on('close', () => {
                state.streams = state.streams.filter((s) => s.res !== res);
            });
            return;
        }

        const one = url.pathname.match(/^\/api\/logs\/(\d+)$/);
        if (one) {
            const log = state.logs.find((l) => l.id === Number(one[1]));
            return log ? json(200, { log: { ...log, event_type: 'invoice.paid' } }) : json(404, { error: 'Log not found' });
        }
        const replays = url.pathname.match(/^\/api\/logs\/(\d+)\/replays$/);
        if (replays && req.method === 'POST') {
            const input = JSON.parse(body);
            const row = { id: state.replays.length + 1, log_id: Number(replays[1]), ...input, created_at: new Date().toISOString() };
            state.replays.push(row);
            return json(201, { id: row.id });
        }
        if (replays) {
            const rows = state.replays.filter((r) => r.log_id === Number(replays[1])).reverse();
            return json(200, { replays: rows });
        }

        json(404, { error: 'Not found' });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
        url: base,
        state,
        /** Sends a new event down every open stream for its endpoint */
        push(log) {
            state.logs.push(log);
            for (const s of state.streams.filter((x) => x.endpointId === log.endpoint_id)) {
                s.res.write(`id: ${log.id}\nevent: log\ndata: ${JSON.stringify(log)}\n\n`);
            }
        },
        async close() {
            for (const s of state.streams) s.res.destroy();
            const closed = new Promise((resolve) => server.close(resolve));
            server.closeAllConnections();
            await closed;
        }
    };
}

/** A local "app under test" that answers every request with `status` */
export async function startHandler(status = 200) {
    const received = [];
    const server = createServer(async (req, res) => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) });
        res.writeHead(handler.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: handler.status < 400 }));
    });
    const handler = { status, received, url: '', close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    handler.url = `http://127.0.0.1:${server.address().port}/webhooks`;
    return handler;
}

export function sampleEndpoint(overrides = {}) {
    return {
        id: 7,
        uuid: '3a8f9b2c-1111-4222-8333-944455556666',
        slug: null,
        catch_id: '3a8f9b2c-1111-4222-8333-944455556666',
        catch_host: null,
        name: 'Stripe dev',
        forward_url: null,
        ...overrides
    };
}

export function sampleLog(overrides = {}) {
    return {
        id: 101,
        number: 12,
        endpoint_id: 7,
        method: 'POST',
        query_params: {},
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abc' },
        body: JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1', amount_paid: 900 } } }),
        body_size: 90,
        is_truncated: 0,
        content_type: 'application/json',
        provider: 'stripe',
        signature_status: 'valid',
        note: null,
        created_at: '2026-10-29T10:00:00.000Z',
        ...overrides
    };
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => resolve(data));
    });
}
