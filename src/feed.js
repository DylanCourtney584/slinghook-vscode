import { eventName } from './shared/eventToCode.js';

/**
 * What the sidebar shows: the workspace's endpoints and, for each endpoint
 * being followed, its newest events (newest first).
 *
 * Plain data with change callbacks, so it can be tested without VS Code.
 */
export class Feed {
    constructor({ maxEvents = 50 } = {}) {
        this.maxEvents = maxEvents;
        /** @type {object[]} */
        this.endpoints = [];
        /** @type {Map<string, object[]>} endpoint uuid -> events, newest first */
        this.events = new Map();
        /** @type {Map<string, {state: string, detail?: string}>} */
        this.status = new Map();
        this.unseen = 0;
        this.listeners = new Set();
    }

    /** @param {(change: {type: string, uuid?: string, log?: object}) => void} listener */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(change) {
        for (const listener of this.listeners) listener(change);
    }

    setEndpoints(endpoints) {
        this.endpoints = endpoints;
        const uuids = new Set(endpoints.map((ep) => ep.uuid));
        for (const uuid of [...this.events.keys()]) {
            if (!uuids.has(uuid)) this.forget(uuid);
        }
        this.emit({ type: 'endpoints' });
    }

    endpoint(uuid) {
        return this.endpoints.find((ep) => ep.uuid === uuid) ?? null;
    }

    /**
     * Adds a streamed event. Duplicates (the same id) are ignored, and the list
     * is cut to maxEvents.
     *
     * @returns {boolean} whether it was new
     */
    addEvent(uuid, log, { live = false } = {}) {
        const list = this.events.get(uuid) ?? [];
        if (list.some((e) => e.id === log.id)) return false;

        list.push(log);
        list.sort((a, b) => b.id - a.id);
        list.length = Math.min(list.length, this.maxEvents);
        this.events.set(uuid, list);

        if (live) this.unseen++;
        this.emit({ type: 'event', uuid, log, live });
        return true;
    }

    eventsFor(uuid) {
        return this.events.get(uuid) ?? [];
    }

    findEvent(id) {
        for (const [uuid, list] of this.events) {
            const log = list.find((e) => e.id === id);
            if (log) return { uuid, log };
        }
        return null;
    }

    setStatus(uuid, state, detail) {
        this.status.set(uuid, { state, detail });
        this.emit({ type: 'status', uuid });
    }

    forget(uuid) {
        this.events.delete(uuid);
        this.status.delete(uuid);
        this.emit({ type: 'endpoint', uuid });
    }

    markSeen() {
        if (this.unseen === 0) return;
        this.unseen = 0;
        this.emit({ type: 'seen' });
    }

    setMaxEvents(maxEvents) {
        this.maxEvents = maxEvents;
        for (const list of this.events.values()) list.length = Math.min(list.length, maxEvents);
        this.emit({ type: 'endpoints' });
    }

    clear() {
        this.endpoints = [];
        this.events.clear();
        this.status.clear();
        this.unseen = 0;
        this.emit({ type: 'endpoints' });
    }
}

// Labels parse the body, so each stored event is labelled once
const labels = new WeakMap();

/** "#12 POST invoice.paid": what a person calls an event */
export function eventLabel(log) {
    if (!labels.has(log)) labels.set(log, buildLabel(log));
    return labels.get(log);
}

function buildLabel(log) {
    const name = eventName(withDashboardFields(log));
    const ref = log.number != null ? `#${log.number}` : `id ${log.id}`;
    return name === 'webhook event' ? `${ref} ${log.method}` : `${ref} ${log.method} ${name}`;
}

/** The endpoint's name, or its catch path when it has none (a bare uuid shortened, as the dashboard does) */
export function endpointLabel(ep) {
    if (ep.name) return ep.name;
    return ep.catch_id && ep.catch_id !== ep.uuid ? `/c/${ep.catch_id}` : `/c/${ep.uuid.slice(0, 8)}…`;
}

/** Where providers send webhooks for this endpoint */
export function catchUrl(ep, server) {
    return ep.catch_host
        ? `https://${ep.catch_host}/${ep.catch_id || ep.uuid}`
        : `${server}/c/${ep.catch_id || ep.uuid}`;
}

/** The generators were written for the dashboard's field names */
export function withDashboardFields(log) {
    return { ...log, contentType: log.content_type, queryParams: log.query_params ?? {} };
}
