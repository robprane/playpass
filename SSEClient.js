export default class SSEClient {
    constructor(sseUrl, authProvider, authCookieName = 'sseAuthorization', onLog = console.log) {
        try {
            this.sseUrl = new URL(sseUrl, window.location.href).href.replace(/\/$/, '');
        } catch (e) {
            this.sseUrl = sseUrl.replace(/\/$/, '');
        }

        // Обратная совместимость: если передали функцию, используем ее.
        // Если передали строку или объект (как это делает AuthClient),
        // оборачиваем их в асинхронную функцию-заглушку.
        if (typeof authProvider === 'function') {
            this.authProvider = authProvider;
        } else {
            this.authProvider = async () => {
                if (typeof authProvider === 'string') return { token: authProvider };
                if (typeof authProvider === 'object' && authProvider !== null) return authProvider;
                return { token: null };
            };
        }

        this.authCookieName = authCookieName;
        this.log = onLog;
        this.eventSource = null;
        this.token = null;
        this.topic = null;
        this.onMessage = null;
        this.refreshPromise = null;
        this.isReconnecting = false;
        this.onReconnect = null;
    }

    async connect(topic, onMessage) {
        this.topic = topic;
        this.onMessage = onMessage;
        await this.#initEventSource();
    }

    async #initEventSource() {
        if (this.eventSource) this.eventSource.close();

        try {
            await this.#refreshToken();

            const url = new URL(this.sseUrl);
            url.searchParams.append('topic', this.topic);

            this.eventSource = new EventSource(url, { withCredentials: true });

            this.eventSource.onopen = () => {
                this.log(`SSE: Connected to ${this.topic}`, 'success');

                const recovered = this.isReconnecting;
                this.isReconnecting = false; // Сбрасываем флаг только когда реально подключились

                if (recovered && typeof this.onReconnect === 'function') {
                    this.onReconnect();
                }
            };

            this.eventSource.onerror = () => {
                this.eventSource.close();
                if (!this.isReconnecting) {
                    this.isReconnecting = true; // Ставим флаг, что начался процесс переподключения
                    this.log('SSE: Connection lost, reconnecting in 3s...', 'error');
                    setTimeout(() => {
                        this.token = null;
                        // this.isReconnecting = false; <-- УБРАЛИ ЭТО ОТСЮДА
                        this.#initEventSource();
                    }, 3000);
                }
            };

            this.eventSource.onmessage = (e) => {
                try {
                    let data = JSON.parse(e.data);
                    if (typeof data === 'string') data = JSON.parse(data);
                    this.onMessage(data);
                } catch (err) {
                    this.log(`SSE: Parse error - ${err.message}`, 'error');
                }
            };

        } catch (err) {
            if (err.message === 'FATAL_AUTH') {
                this.log('SSE: Critical auth failure. Please log in again.', 'error');
                this.isReconnecting = false;
                return;
            }

            this.log(`SSE Init error: ${err.message}. Retrying in 5s...`, 'error');
            setTimeout(() => {
                this.token = null;
                // this.isReconnecting = false; <-- УБРАЛИ ЭТО ОТСЮДА
                this.#initEventSource();
            }, 5000);
        }
    }

    async #refreshToken() {
        if (this.token) return;

        if (!this.refreshPromise) {
            this.refreshPromise = (async () => {
                try {
                    const data = await this.authProvider();
                    this.token = data.token;
                    document.cookie = `${this.authCookieName}=${this.token}; path=/; max-age=3600; SameSite=Lax`;
                } catch (e) {
                    this.log(`Auth Provider Error: ${e.message}`, 'error');
                    throw e;
                } finally {
                    this.refreshPromise = null;
                }
            })();
        }
        await this.refreshPromise;
    }

    async publish(topic, data, retryCount = 0) {
        await this.#refreshToken();

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Bearer ${this.token}`
        };

        const res = await fetch(this.sseUrl, {
            method: 'POST',
            headers,
            body: new URLSearchParams({ topic: topic, data: JSON.stringify(data) })
        });

        if (res.status === 401 && retryCount < 1) {
            this.log('SSE: Token expired, refreshing...', 'error');
            this.token = null;
            return this.publish(topic, data, retryCount + 1);
        }

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`SSE Publish failed (${res.status}): ${text}`);
        }
    }

    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
            this.log('SSE: Disconnected');
        }
    }
}
