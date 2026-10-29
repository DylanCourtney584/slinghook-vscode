/**
 * One captured event as a read-only JSON document: what arrived (method,
 * query, headers, body) plus what SlingHook made of it. A JSON body is
 * inlined as a value so the editor can fold and colour it; anything else
 * stays a string.
 */
export function formatEvent(log) {
    const doc = {
        event: log.number ?? null,
        received_at: log.created_at ?? null,
        method: log.method,
        ...(log.event_type ? { event_type: log.event_type } : {}),
        provider: log.provider ?? null,
        signature: log.signature_status ?? 'unverified',
        content_type: log.content_type ?? null,
        size_bytes: log.body_size ?? null,
        ...(Number(log.is_truncated) === 1 ? { truncated: 'The body was larger than the capture limit; only its start was stored.' } : {}),
        ...(log.note ? { note: log.note } : {}),
        query: log.query_params ?? {},
        headers: log.headers ?? {},
        body: parseBody(log.body)
    };
    return JSON.stringify(doc, null, 2) + '\n';
}

/** The file name the event's tab shows, e.g. "#12 invoice.paid.json" */
export function eventFileName(log, label) {
    const safe = String(label).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    return `${safe}.json`;
}

function parseBody(body) {
    if (body === null || body === undefined || body === '') return null;
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}
