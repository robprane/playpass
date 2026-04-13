import SSEClient from './SSEClient.js?v{{ Math.floor(Date.now()/1000/60) }}';

export default class AuthClient {
    apiUrl;
    accessToken = null;
    handshakeToken = null;
    sessionId = null;
    sseUrl = null;
    onLog;
    onStateChange;

    #sseClient = null;
    #initPromise = null;

    constructor(config) {
        let apiUrlStr = config.apiUrl;
        // If apiUrl doesn't start with http/https, try to resolve it against window.location.href,
        // but since we want to support cross-origin API hosts fully, we use URL constructor and then stringify it
        try {
            this.apiUrl = new URL(apiUrlStr, window.location.href).href.replace(/\/$/, '');
        } catch (e) {
            this.apiUrl = apiUrlStr.replace(/\/$/, '');
        }

        this.onLog = config.onLog ?? console.log;
        this.onStateChange = config.onStateChange ?? (() => {});
    }

    async init() {
        this.#initPromise ??= this.#performInit();
        return this.#initPromise;
    }

    async forceRefresh() {
        await this.#refresh();
    }

    async #performInit() {
        this.#log('System: Initializing...');

        try {
            await this.#refresh();
            this.#log('System: Session restored', 'success');
        } catch (e) {
            this.#log('System: Guest mode');
        }

        if (!this.handshakeToken) {
            try {
                const res = await this.#fetchWithTimeout(`${this.apiUrl}/auth/handshake`, { method: 'POST' });
                if (!res.ok) throw new Error('Handshake failed');

                const data = await res.json();
                this.handshakeToken = data.token;
                this.sessionId = data.sessionId;
                try {
                    this.sseUrl = new URL(data.sseUrl, this.apiUrl).href;
                } catch(e) {
                    this.sseUrl = data.sseUrl;
                }

                this.#connectSSE();
                this.#log(`System: Handshake OK (SID: ${this.sessionId})`);
            } catch (e) {
                this.#log('System: Handshake Error', 'error');
                console.error(e);
            }
        }
    }

    async register() {
        await this.init();
        const { startRegistration } = await import('https://esm.sh/@simplewebauthn/browser@10.0.0');
        const optRes = await this.#postPublic('/auth/register/options', { token: this.handshakeToken });
        const options = await optRes.json();
        const cred = await startRegistration(options);
        const res = await this.#postPublic('/auth/register/verify', { token: this.handshakeToken, data: cred });
        const data = await res.json();
        this.#setSession(data.accessToken);
        this.#log('Auth: Registered successfully!', 'success');
    }

    async login() {
        await this.init();
        const { startAuthentication } = await import('https://esm.sh/@simplewebauthn/browser@10.0.0');
        const optRes = await this.#postPublic('/auth/login/options', { token: this.handshakeToken });
        const options = await optRes.json();
        const assertion = await startAuthentication(options);
        const res = await this.#postPublic('/auth/login/verify', { token: this.handshakeToken, data: assertion });
        const data = await res.json();
        this.#setSession(data.accessToken);
        this.#log('Auth: Logged in!', 'success');
    }

    async approveRemoteSession(targetSid) {
        this.#log('QR: Verifying identity...');
        const { startAuthentication } = await import('https://esm.sh/@simplewebauthn/browser@10.0.0');
        try {
            const res = await this.#postProtected('/auth/connect/qr-options', { targetSessionId: targetSid });
            const { options, challengeToken } = await res.json();
            const assertion = await startAuthentication(options);
            await this.#postProtected('/auth/connect/qr-approve', {
                targetSessionId: targetSid,
                verification: assertion,
                challengeToken: challengeToken
            });
            this.#log('QR: Remote session approved!', 'success');
        } catch (e) {
            this.#log('QR: Approval failed - ' + e.message, 'error');
            throw e;
        }
    }

    async startQrScanner(videoElement) {
        if (!('BarcodeDetector' in window)) throw new Error('BarcodeDetector not supported');
        let stream, interval;
        const stopScanner = () => {
            clearInterval(interval);
            if (stream) stream.getTracks().forEach(t => t.stop());
        };
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
            videoElement.srcObject = stream;
            await videoElement.play();
            const detector = new BarcodeDetector({ formats: ['qr_code'] });
            return new Promise((resolve, reject) => {
                interval = setInterval(async () => {
                    try {
                        const codes = await detector.detect(videoElement);
                        if (codes.length > 0) {
                            const raw = codes[0].rawValue;
                            let sid = raw;
                            try { sid = new URL(raw).searchParams.get('sid') || raw; } catch(e) {}
                            stopScanner();
                            this.approveRemoteSession(sid).then(resolve).catch(reject);
                        }
                    } catch(e) {}
                }, 200);
            });
        } catch(e) {
            stopScanner();
            throw new Error('Camera error: ' + e.message);
        }
    }

    async getQrCodeSvg() {
        await this.init();
        if (!this.sessionId) throw new Error('Session not ready');
        const { default: QRCode } = await import('https://esm.sh/qrcode@1.4.4');
        const authUrl = `${window.location.origin}${window.location.pathname}?sid=${this.sessionId}`;
        const svgString = await QRCode.toString(authUrl, { type: 'svg', margin: 1, width: 256 });
        this.#log('QR: Code generated');
        return svgString;
    }

    async linkEmail(email) {
        await this.#postProtected('/auth/connect/email', { email });
        this.#log('Email sent', 'success');
    }

    async recoverAccess(email) {
        await this.#postPublic('/auth/recovery/request', { email });
        this.#log('Recovery email sent', 'success');
    }

    async logout() {
        try { await this.#postProtected('/auth/session/logout', {}); } catch(e){}
        this.accessToken = null;
        this.handshakeToken = null;
        this.sessionId = null;
        this.#initPromise = null;
        if (this.#sseClient) {
            this.#sseClient.disconnect();
            this.#sseClient = null;
        }
        this.onStateChange(false, null);
        this.#log('Logged out');
    }

    #setSession(token) {
        this.accessToken = token;
        this.onStateChange(!!token, token);
    }

    async #fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(id);
            return res;
        } catch (error) {
            clearTimeout(id);
            if (error.name === 'AbortError') throw new Error('Request timeout');
            throw error;
        }
    }

    async #postPublic(path, body) {
        const res = await this.#fetchWithTimeout(this.apiUrl + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw await this.#handleError(res);
        return res;
    }

    async #postProtected(path, body) {
        const doFetch = async (t) => this.#fetchWithTimeout(this.apiUrl + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${t}`
            },
            credentials: 'include',
            body: JSON.stringify(body)
        });
        let res = await doFetch(this.accessToken);
        if (res.status === 401) {
            try {
                await this.#refresh();
                res = await doFetch(this.accessToken);
            } catch(e) { throw new Error('Unauthorized'); }
        }
        if (!res.ok) throw await this.#handleError(res);
        return res;
    }

    async #refresh() {
        const res = await this.#fetchWithTimeout(`${this.apiUrl}/auth/session/refresh`, { method: 'POST', credentials: 'include' });
        if (!res.ok) throw new Error('Refresh failed');
        const data = await res.json();
        this.#setSession(data.accessToken);
    }

    async #handleError(res) {
        const err = await res.json().catch(() => ({}));
        return new Error(err?.message ?? err?.error ?? `API Error: ${res.status}`);
    }

    #connectSSE() {
        if (!this.sseUrl || this.#sseClient) return;
        this.#sseClient = new SSEClient(this.sseUrl, null);
        this.#sseClient.connect(`auth/${this.sessionId}`, async (d) => {
            if (d.type === 'exchange_token') {
                this.#log('QR: Token received! Logging in...');
                try {
                    const res = await this.#fetchWithTimeout(`${this.apiUrl}/auth/session/exchange`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ token: d.token })
                    });
                    const data = await res.json();
                    this.#setSession(data.accessToken);
                    this.#log('QR: Login Success!', 'success');
                } catch(e) { console.error(e); }
            }
        });
    }

    #log(m, t) { this.onLog(m, t); }
}
