// Shared transport permits only; callers retain their own payloads, cancellation and persistence.
(function (global) {
    'use strict';
    const lanes = new Map();
    function key(config = {}) {
        const raw = config.url || config.baseUrl || config.cloudUrl || config.volcUrl || config.domain || config.provider || 'default';
        try { return new URL(raw).origin; }
        catch (_) { return String(raw).split(/[?#]/)[0]; }
    }
    function aborted() { return new DOMException('任务已取消', 'AbortError'); }
    function acquire(config, signal, background = false) {
        const id = key(config);
        let lane = lanes.get(id);
        if (!lane) lanes.set(id, lane = { active: 0, waiting: [] });
        return new Promise((resolve, reject) => {
            const item = { background, start() {
                signal?.removeEventListener('abort', cancel);
                lane.active++;
                let released = false;
                resolve(() => { if (released) return; released = true; lane.active--; drain(); });
            } };
            const cancel = () => { lane.waiting = lane.waiting.filter(entry => entry !== item); reject(signal?.reason || aborted()); };
            if (signal?.aborted) return cancel();
            signal?.addEventListener('abort', cancel, { once: true });
            lane.waiting.push(item);
            drain();
        });
        function drain() {
            lane.waiting.sort((a, b) => Number(a.background) - Number(b.background));
            while (lane.active < 2 && lane.waiting.length) lane.waiting.shift().start();
            if (!lane.active && !lane.waiting.length) lanes.delete(id);
        }
    }
    global.ChatRequestGate = Object.freeze({ acquire, key });
})(globalThis);
