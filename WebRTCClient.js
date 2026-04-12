import SSEClient from './SSEClient.js?v{{ Math.floor(Date.now()/1000/60) }}';

export default class WebRTCClient {
    constructor(sseUrl, roomId, sessionId, userId, authProvider, authCookieName = 'sseAuthorization', onLog = console.log) {
        this.topic = `webrtc/room/${roomId}`;
        this.sessionId = sessionId;
        this.userId = userId;
        this.peers = {};
        this.log = onLog;
        this.sse = new SSEClient(sseUrl, authProvider, authCookieName, onLog);
        this.outSeq = 0;
        this.messageQueue = [];
        this.onMessage = null;
    }

    async connect() {
        this.log(`WebRTC: Joining topic ${this.topic}...`);

        this.sse.onReconnect = async () => {
            let needsResync = Object.keys(this.peers).length === 0;

            for (const peerId in this.peers) {
                const pc = this.peers[peerId].pc;
                if (!pc || (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed')) {
                    needsResync = true;
                    // Очищаем зависшие состояния, готовимся стать Answerer-ом
                    const existingSeq = this.peers[peerId].inSeq || 0;
                    const userId = this.peers[peerId].userId;
                    this.#cleanupConnection(peerId);
                    this.peers[peerId] = { userId, inSeq: existingSeq };
                }
            }

            if (needsResync) {
                this.log('WebRTC: SSE restored, sending rejoin signal to resync...');
                await this.#sendSignal({ type: 'join', userId: this.userId });
            } else {
                this.log('WebRTC: SSE restored, all peers already connected. Skipping rejoin.');
            }
        };

        await this.sse.connect(this.topic, async (msg) => {
            const incomingFrom = String(msg.from);
            const incomingTo = msg.to ? String(msg.to) : null;
            const mySessionId = String(this.sessionId);

            if (incomingFrom === mySessionId) return;
            if (incomingTo && incomingTo !== mySessionId) return;

            await this.#handleSignal(msg);
        });

        await this.#sendSignal({ type: 'join', userId: this.userId });
    }

    disconnect() {
        this.sse.disconnect();
        for (const peerId in this.peers) {
            this.#cleanupConnection(peerId);
        }
        this.peers = {};
        this.log('WebRTC: All connections closed');
    }

    #cleanupConnection(peerId) {
        const peer = this.peers[peerId];
        if (!peer) return;

        if (peer.reconnectTimer) clearTimeout(peer.reconnectTimer);
        if (peer.pingInterval) clearInterval(peer.pingInterval);

        if (peer.dc) {
            peer.dc.onclose = null;
            peer.dc.onmessage = null;
            peer.dc.close();
        }
        if (peer.pc) {
            peer.pc.oniceconnectionstatechange = null;
            peer.pc.onicecandidate = null;
            peer.pc.onnegotiationneeded = null;
            peer.pc.ondatachannel = null;
            peer.pc.close();
        }

        peer.pc = null;
        peer.dc = null;
        peer.iceQueue = [];
        peer.isInitiator = false;
    }

    async #handleSignal({ from, data }) {
        if (data.type === 'join') {
            this.log(`Signal: Peer joined/rejoined [Session: ${from}, User: ${data.userId}]`);

            // Сохраняем inSeq, если пир уже существовал
            const existingSeq = this.peers[from]?.inSeq || 0;

            this.#cleanupConnection(from);

            // Передаем сохраненный inSeq в новый объект
            this.peers[from] = { userId: data.userId, inSeq: existingSeq };
            this.#createPeer(from, true);
        }
        else if (data.type === 'offer') {
            // Glare Detection: если мы тоже Инициатор, решаем конфликт лексикографическим сравнением ID
            const isGlare = this.peers[from]?.pc && this.peers[from].isInitiator;
            const amIWinner = String(this.sessionId).localeCompare(String(from)) > 0;

            if (isGlare && amIWinner) {
                this.log(`WebRTC: Glare detected. I am the winner, ignoring incoming offer from ${from}`);
                return; // Игнорируем их Offer, наш имеет приоритет
            }

            this.log(`Signal: Offer received from ${from}, sending answer`);

            const existingSeq = this.peers[from]?.inSeq || 0;
            const userId = this.peers[from]?.userId;

            this.#cleanupConnection(from);
            this.peers[from] = { userId, inSeq: existingSeq };

            this.#createPeer(from, false);
            await this.peers[from].pc.setRemoteDescription(new RTCSessionDescription(data));
            const answer = await this.peers[from].pc.createAnswer();
            await this.peers[from].pc.setLocalDescription(answer);
            await this.#sendSignal(this.peers[from].pc.localDescription, from);
            this.#processIceQueue(from);
        }
        else if (data.type === 'answer' && this.peers[from]?.pc) {
            this.log(`Signal: Answer received from ${from}`);
            await this.peers[from].pc.setRemoteDescription(new RTCSessionDescription(data));
            this.#processIceQueue(from);
        }
        else if (data.type === 'ice-candidate' && this.peers[from]?.pc) {
            const candidate = new RTCIceCandidate(data.candidate);
            if (this.peers[from].pc.remoteDescription && this.peers[from].pc.remoteDescription.type) {
                try {
                    await this.peers[from].pc.addIceCandidate(candidate);
                } catch (e) {
                    this.log(`ICE Error: ${e.message}`, 'error');
                }
            } else {
                if (!this.peers[from].iceQueue) this.peers[from].iceQueue = [];
                this.peers[from].iceQueue.push(candidate);
            }
        }
    }

    #processIceQueue(peerId) {
        if (!this.peers[peerId] || !this.peers[peerId].iceQueue) return;
        while (this.peers[peerId].iceQueue.length > 0) {
            const candidate = this.peers[peerId].iceQueue.shift();
            this.peers[peerId].pc.addIceCandidate(candidate).catch(e => this.log(`ICE Error: ${e.message}`, 'error'));
        }
    }

    #createPeer(peerId, isInitiator) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this.peers[peerId].pc = pc;
        this.peers[peerId].isInitiator = isInitiator;
        this.peers[peerId].iceQueue = [];

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.#sendSignal({ type: 'ice-candidate', candidate: e.candidate }, peerId);
            }
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            this.log(`WebRTC: Connection state with ${peerId} is ${state}`);

            if (state === 'connected' || state === 'completed') {
                if (this.peers[peerId].reconnectTimer) {
                    clearTimeout(this.peers[peerId].reconnectTimer);
                    this.peers[peerId].reconnectTimer = null;
                }
            }
            else if (state === 'disconnected' || state === 'failed') {
                if (this.peers[peerId].reconnectTimer) return;

                this.peers[peerId].reconnectTimer = setTimeout(() => {
                    this.log(`WebRTC: Hard reset connection with ${peerId}...`);
                    const initRole = this.peers[peerId].isInitiator;
                    this.#cleanupConnection(peerId);

                    if (initRole) {
                        this.#createPeer(peerId, true);
                    }
                }, 5000);
            }
        };

        if (isInitiator) {
            const dc = pc.createDataChannel('gameData');
            this.#setupDataChannel(dc, peerId);
            this.peers[peerId].dc = dc;

            pc.onnegotiationneeded = async () => {
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    await this.#sendSignal(pc.localDescription, peerId);
                } catch (e) {
                    this.log(`Negotiation error: ${e.message}`, 'error');
                }
            };
        } else {
            pc.ondatachannel = (e) => {
                this.#setupDataChannel(e.channel, peerId);
                this.peers[peerId].dc = e.channel;
            };
        }
    }

    #setupDataChannel(dc, peerId) {
        dc.onopen = () => {
            this.log(`DataChannel: OPENED with Session ${peerId}`, 'success');

            // Note: Since we have multiple peers, sending all queued messages to the first peer that reconnects
            // could be fine if we only care about broadcasting. To be safe, we just send all queued messages
            // over this newly opened channel. The recipients will deduplicate based on `seq`.
            // We shouldn't clear the queue entirely here if other peers might need them, but currently
            // the logic just broadcasts. We'll leave the messages in the queue until we know they are sent
            // to all active peers, OR we can just drain the queue. Currently it drains the queue which means
            // only the first connected peer gets the queued messages. Let's fix that so we broadcast
            // queued messages to ALL open channels and then clear the queue.

            // Instead of just draining `messageQueue` to this specific peer, we call a helper
            // that tries to flush the queue to all connected peers.
            this.#flushMessageQueue();

            this.peers[peerId].pingInterval = setInterval(() => {
                if (dc.readyState === 'open') {
                    dc.send(JSON.stringify({ type: 'sys_ping' }));
                }
            }, 15000);
        };

        dc.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'sys_ping') return;
                this.#processIncomingMessage(peerId, data);
            } catch (err) {}
        };
    }

    #flushMessageQueue() {
        if (this.messageQueue.length === 0) return;

        let anySent = false;
        // Collect messages to send
        const messagesToSend = [...this.messageQueue];

        for (const peerId in this.peers) {
            const dc = this.peers[peerId].dc;
            if (dc && dc.readyState === 'open') {
                for (const msg of messagesToSend) {
                    dc.send(msg);
                }
                anySent = true;
                this.log(`DataChannel: Flushed queued messages to ${peerId}`);
            }
        }

        // If we successfully sent the messages to at least one peer (since broadcast means sending to any/all available),
        // we can consider the queue flushed.
        if (anySent) {
            this.messageQueue = [];
        }
    }

    #processIncomingMessage(peerId, data) {
        if (!this.peers[peerId]) return;

        if (data.seq) {
            const currentSeq = this.peers[peerId].inSeq || 0;
            if (data.seq <= currentSeq) return;
            this.peers[peerId].inSeq = data.seq;
        }

        this.log(`DataChannel [Session ${peerId}]: ${JSON.stringify(data)}`);

        // Add this callback trigger
        if (typeof this.onMessage === 'function') {
            this.onMessage(peerId, data);
        }
    }

    async #sendSignal(data, to = null, retries = 3) {
        const payload = { from: this.sessionId, to, data };

        for (let i = 0; i < retries; i++) {
            try {
                await this.sse.publish(this.topic, payload);
                return;
            } catch (err) {
                if (i === retries - 1) {
                    this.log(`Signal delivery failed: ${err.message}`, 'error');
                    return;
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    broadcast(payload) {
        this.outSeq++;
        const messageStr = JSON.stringify({ seq: this.outSeq, ...payload });

        let sentToAny = false;
        for (const peerId in this.peers) {
            const dc = this.peers[peerId].dc;
            if (dc && dc.readyState === 'open') {
                dc.send(messageStr);
                sentToAny = true;
            }
        }

        if (!sentToAny) {
            this.log('WebRTC: No open DataChannels, queuing message');
            this.messageQueue.push(messageStr);
        } else {
            // Also attempt to flush any previously queued messages if we found an open channel
            // (though #flushMessageQueue is also called on data channel open)
            this.#flushMessageQueue();
        }
    }
}
