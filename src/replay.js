import { forwardLog } from './shared/forward.js';
import { expectsRejection, findBaseline, isPassing, verdictFor } from './shared/verdict.js';

export const VERDICT_TEXT = {
    fixed: 'fixed: it failed last time and passes now',
    regressed: 'regressed: it passed last time and fails now',
    still_failing: 'still failing',
    still_passing: 'still passing'
};

/**
 * Sends a stored event from this machine to `target` (like `shk listen` and
 * the MCP replay_event tool), records it in the dashboard's replay history,
 * and compares it with the attempt before it.
 *
 * @param {object} opts
 * @param {ReturnType<import('./shared/api.js').createApi>} opts.api
 * @param {object} opts.log      A full log row from /api/logs/:id
 * @param {string} opts.target   e.g. http://localhost:3000/webhooks
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function replayEvent({ api, log, target, fetchImpl = fetch }) {
    if (Number(log.is_truncated) === 1) {
        throw new Error(`Event #${log.number} was larger than the capture limit and only its start was stored, so it can't be replayed.`);
    }

    const result = await forwardLog(log, target, { fetchImpl });
    const expectRejection = expectsRejection(log);
    const passed = isPassing({ response_status: result.status, error_message: result.error }, expectRejection);

    let recorded = true;
    let recordError = null;
    try {
        await api.post(`/api/logs/${log.id}/replays`, {
            target_url: result.url,
            response_status: result.status,
            response_body: result.body,
            error_message: result.error,
            duration_ms: result.durationMs
        });
    } catch (err) {
        recorded = false;
        recordError = err.message;
    }

    let verdict = null;
    if (recorded) {
        try {
            const { replays = [] } = await api.get(`/api/logs/${log.id}/replays`);
            verdict = verdictFor(findBaseline(replays, replays[0]), replays[0], expectRejection);
        } catch {
            // The delivery happened; only the comparison is missing
        }
    }

    return { ...result, passed, expectRejection, recorded, recordError, verdict };
}

/** "#12 → 200 in 34 ms · fixed: …" */
export function describeReplay(log, outcome) {
    const ref = log.number != null ? `#${log.number}` : `id ${log.id}`;
    const answer = outcome.error ? outcome.error : `HTTP ${outcome.status}`;
    const parts = [`${ref} → ${answer} in ${outcome.durationMs} ms`];
    if (outcome.verdict) parts.push(VERDICT_TEXT[outcome.verdict]);
    if (outcome.expectRejection) {
        parts.push(outcome.passed ? 'rejected, as it should be: the signature is invalid' : 'the signature is invalid, so your handler should have rejected it');
    }
    if (!outcome.recorded) parts.push(`not saved to the replay history (${outcome.recordError})`);
    return parts.join(' · ');
}

/**
 * The replay target as typed, or an error message. Any http(s) URL is
 * allowed: the person chose it, and the request goes from their machine.
 */
export function checkTarget(value) {
    let url;
    try {
        url = new URL(String(value ?? '').trim());
    } catch {
        return { error: 'Enter a full URL, e.g. http://localhost:3000/webhooks' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { error: 'Only http:// and https:// URLs can be replayed to.' };
    }
    return { url: url.toString() };
}
