export default class CommitRevealClient {
    constructor(webrtcClient, onResult = null, onLog = console.log) {
        this.rtc = webrtcClient;
        this.onResult = onResult;
        this.log = onLog;

        // Map of active actions: actionId -> state object
        this.actions = new Map();

        this.rtc.onMessage = (peerId, data) => this.#handleMessage(peerId, data);
    }

    /**
     * @param {string} actionId - Unique identifier for the specific event
     * @param {any} payload - User action data. If null, acts as PRNG
     * @param {number} timeoutMs - Safety timeout (default 5 min)
     */
    async execute(actionId, payload = null, timeoutMs = 300000) {
        let act = this.#getOrCreateAction(actionId);

        if (act.localCommitted) {
            throw new Error(`Action ${actionId} already initiated locally`);
        }

        act.isPrngOnly = (payload === null);
        act.localPayload = payload;
        act.localSalt = this.#generateHexSecret(16);
        act.localCommitted = true;

        const dataToHash = act.localPayload !== null
            ? JSON.stringify(act.localPayload) + act.localSalt
            : act.localSalt;

        act.localHash = await this.#sha256(dataToHash);

        // Record our own data in the tracking maps
        act.commits.set(this.rtc.sessionId, act.localHash);
        act.reveals.set(this.rtc.sessionId, { payload: act.localPayload, salt: act.localSalt });

        this.rtc.broadcast({
            type: 'cr_commit',
            actionId: actionId,
            hash: act.localHash,
            isPrngOnly: act.isPrngOnly
        });

        this.log(`CR [${actionId}]: Initiated locally. Mode: ${act.isPrngOnly ? 'PRNG' : 'Action'}`);

        // Set safety cleanup timer
        act.timeoutTimer = setTimeout(() => this.#handleTimeout(actionId), timeoutMs);

        // Check if we already have all commits from others
        this.#checkCommitPhase(actionId);

        return new Promise((resolve, reject) => {
            act.resolve = resolve;
            act.reject = reject;
        });
    }

    async #handleMessage(peerId, data) {
        if (!data.actionId || !['cr_commit', 'cr_reveal'].includes(data.type)) return;

        const actionId = data.actionId;
        const act = this.#getOrCreateAction(actionId);

        if (data.type === 'cr_commit') {
            if (act.commits.has(peerId)) return;
            act.commits.set(peerId, data.hash);
            this.log(`CR [${actionId}]: Commit from ${peerId}`);

            // Auto-respond if it's a PRNG request and we haven't committed yet
            if (data.isPrngOnly && !act.localCommitted) {
                this.execute(actionId, null).catch(() => {});
            }

            this.#checkCommitPhase(actionId);
        }

        else if (data.type === 'cr_reveal') {
            if (act.reveals.has(peerId)) return;
            act.reveals.set(peerId, { payload: data.payload, salt: data.salt });
            this.log(`CR [${actionId}]: Reveal from ${peerId}`);
            await this.#checkRevealPhase(actionId);
        }
    }

    #getOrCreateAction(actionId) {
        if (!this.actions.has(actionId)) {
            this.actions.set(actionId, {
                state: 'COMMIT',
                localCommitted: false,
                isPrngOnly: true,
                localPayload: null,
                localSalt: null,
                localHash: null,
                commits: new Map(),
                reveals: new Map(),
                resolve: null,
                reject: null,
                timeoutTimer: null
            });
        }
        return this.actions.get(actionId);
    }

    #checkCommitPhase(actionId) {
        const act = this.actions.get(actionId);
        if (!act || act.state !== 'COMMIT' || !act.localCommitted) return;

        const expectedPeers = Object.keys(this.rtc.peers).length + 1;
        if (act.commits.size >= expectedPeers) {
            act.state = 'REVEAL';
            this.log(`CR [${actionId}]: All commits in. Broadcasting reveal.`);

            this.rtc.broadcast({
                type: 'cr_reveal',
                actionId: actionId,
                payload: act.localPayload,
                salt: act.localSalt
            });

            this.#checkRevealPhase(actionId);
        }
    }

    async #checkRevealPhase(actionId) {
        const act = this.actions.get(actionId);
        if (!act || act.state !== 'REVEAL') return;

        const expectedPeers = Object.keys(this.rtc.peers).length + 1;
        if (act.reveals.size >= expectedPeers) {

            const actionResults = {};
            for (const [peerId, reveal] of act.reveals.entries()) {
                const expectedHash = act.commits.get(peerId);
                const dataToHash = reveal.payload !== null
                    ? JSON.stringify(reveal.payload) + reveal.salt
                    : reveal.salt;

                const actualHash = await this.#sha256(dataToHash);

                if (actualHash !== expectedHash) {
                    return this.#finalize(actionId, new Error(`Hash mismatch for ${peerId}`), null);
                }
                actionResults[peerId] = reveal.payload;
            }

            const seed = await this.#generateSeed(act);
            this.#finalize(actionId, null, { seed, actions: actionResults });
        }
    }

    #finalize(actionId, error, result) {
        const act = this.actions.get(actionId);
        if (!act) return;

        if (act.timeoutTimer) clearTimeout(act.timeoutTimer);

        if (error) {
            this.log(`CR [${actionId}] Failed: ${error.message}`, 'error');
            if (act.reject) act.reject(error);
        } else {
            this.log(`CR [${actionId}] Success`, 'success');
            if (act.resolve) act.resolve(result);
            if (this.onResult) this.onResult(actionId, result);
        }

        this.actions.delete(actionId);
    }

    #handleTimeout(actionId) {
        this.#finalize(actionId, new Error('Action timed out'), null);
    }

    async #generateSeed(act) {
        let combined = "";
        const sortedPeers = Array.from(act.reveals.keys()).sort();
        for (const pid of sortedPeers) {
            combined += act.reveals.get(pid).salt;
        }
        const hash = await this.#sha256(combined);
        return parseInt(hash.substring(0, 8), 16);
    }

    #generateHexSecret(bytes) {
        const arr = new Uint8Array(bytes);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    }

    async #sha256(str) {
        const buf = new TextEncoder().encode(str);
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    }
}
