// WebSocket transport for Mighty Men of David.
//
// All players connect to a single server-authoritative Durable Object (see
// src/worker.js) which sends each player a filtered view of the game. This works
// across any network — no NAT traversal, no peer connections.
//
// Public surface used by the UI: createGame / joinGame / rejoinGame / doAction /
// getPublicState / getKnowledge / onStateUpdate / onConnectionChange / onError.

function dbg(category, ...args) {
  const ts = new Date().toISOString().substr(11, 12);
  console.log(`[${ts}][${category}]`, ...args);
}

class GameTransport {
  constructor() {
    this.gameCode = null;
    this.playerId = null;
    this.token = null;
    this.isHost = false;

    this.ws = null;
    this.publicState = null;   // latest per-player filtered state from server
    this.knowledge = null;     // latest per-player knowledge from server

    // Callbacks (set by the UI)
    this.onStateUpdate = null;
    this.onConnectionChange = null;
    this.onError = null;

    // Reconnection
    this._intentionalClose = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reconnectDelays = [1000, 2000, 4000, 8000, 16000];

    // Pending connect() promise
    this._connectResolve = null;
    this._connectReject = null;
    this._gotFirstState = false;
  }

  // ============ Identity persistence (per game code) ============

  _identityKey(code) {
    return `mightymen_id_${code.toUpperCase()}`;
  }

  _saveIdentity() {
    if (!this.gameCode || !this.playerId || !this.token) return;
    try {
      localStorage.setItem(
        this._identityKey(this.gameCode),
        JSON.stringify({ playerId: this.playerId, token: this.token })
      );
    } catch { /* storage unavailable */ }
  }

  _loadIdentity(code) {
    try {
      const raw = localStorage.getItem(this._identityKey(code));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ============ Public API used by the UI ============

  async createGame(hostName) {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: hostName })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);

    this.gameCode = result.gameCode;
    this.playerId = result.playerId;
    this.token = result.token;
    this.isHost = true;
    this._saveIdentity();

    await this._connect({ playerId: this.playerId, token: this.token });
    return { gameCode: this.gameCode, playerId: this.playerId };
  }

  async joinGame(gameCode, playerName) {
    this.gameCode = gameCode.toUpperCase();
    await this._connect({ name: playerName });
    return { gameCode: this.gameCode, playerId: this.playerId };
  }

  async rejoinGame(gameCode, playerName) {
    const code = gameCode.toUpperCase();
    const identity = this._loadIdentity(code);
    // No saved credentials → let the UI fall back to a fresh join.
    if (!identity) {
      throw new Error('No player with that name found in this game');
    }
    this.gameCode = code;
    this.playerId = identity.playerId;
    this.token = identity.token;
    await this._connect({ playerId: identity.playerId, token: identity.token });
    return { gameCode: this.gameCode, playerId: this.playerId, isHost: this.isHost };
  }

  doAction(action, data = {}) {
    this._send({ type: 'action', action, data });
  }

  getPublicState() {
    return this.publicState;
  }

  getKnowledge() {
    return this.knowledge;
  }

  destroy() {
    this._intentionalClose = true;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  // ============ Connection management ============

  // Opens a WebSocket and resolves once the first state has arrived.
  _connect(hello) {
    this._hello = hello;
    this._gotFirstState = false;

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/ws?code=${encodeURIComponent(this.gameCode)}`;
      dbg('WS', 'Connecting to', url);

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;
      this._intentionalClose = false;

      // Guard against a connection that never completes.
      const timeout = setTimeout(() => {
        if (!this._gotFirstState) {
          dbg('WS', 'Connection timed out');
          try { ws.close(); } catch { /* ignore */ }
          this._rejectConnect(new Error('Timeout connecting to game'));
        }
      }, 15000);

      ws.onopen = () => {
        dbg('WS', 'Open, sending hello');
        this._send({ type: 'hello', ...this._hello });
      };

      ws.onmessage = (event) => {
        clearTimeout(timeout);
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        this._handleMessage(msg);
      };

      ws.onclose = () => {
        dbg('WS', 'Closed');
        clearTimeout(timeout);
        this._handleClose();
      };

      ws.onerror = (e) => {
        dbg('WS', 'Error', e && e.message);
      };
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'identity':
        this.playerId = msg.playerId;
        this.token = msg.token;
        this.isHost = !!msg.isHost;
        this._saveIdentity();
        break;

      case 'state':
        this.publicState = msg.state;
        this.knowledge = msg.knowledge;
        if (!this._gotFirstState) {
          this._gotFirstState = true;
          this._reconnectAttempt = 0;
          this._resolveConnect();
          this._emit({ type: 'connected-to-host' });
        }
        if (this.onStateUpdate) this.onStateUpdate(this.publicState);
        break;

      case 'error':
        if (!this._gotFirstState) {
          // Failure during initial connect → reject so the UI can react.
          this._rejectConnect(new Error(msg.message));
        } else if (this.onError) {
          this.onError(msg.message);
        }
        break;
    }
  }

  _handleClose() {
    this.ws = null;
    if (this._intentionalClose) return;

    // If we never finished connecting, reject the pending promise.
    if (!this._gotFirstState) {
      this._rejectConnect(new Error('Connection closed'));
      return;
    }

    // Established connection dropped → attempt to reconnect (dedup with a flag).
    this._emit({ type: 'disconnected-from-host' });
    if (!this._reconnecting) this._scheduleReconnect();
  }

  async _scheduleReconnect() {
    this._reconnecting = true;
    this._emit({ type: 'reconnecting' });

    const idx = Math.min(this._reconnectAttempt, this._reconnectDelays.length - 1);
    const base = this._reconnectDelays[idx];
    const jitter = (Math.random() * 0.5 - 0.25) * base;
    const delay = Math.max(500, Math.round(base + jitter));
    this._reconnectAttempt++;

    dbg('WS', `Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);
    await new Promise((r) => setTimeout(r, delay));

    try {
      await this._connect({ playerId: this.playerId, token: this.token });
      dbg('WS', 'Reconnected');
      this._reconnecting = false;
    } catch (e) {
      dbg('WS', `Reconnect failed: ${e.message}`);
      this._reconnecting = false;
      this._scheduleReconnect(); // keep trying with backoff
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      dbg('WS', 'Cannot send, socket not open:', obj.type);
    }
  }

  // ============ Helpers ============

  _resolveConnect() {
    if (this._connectResolve) {
      this._connectResolve();
      this._connectResolve = null;
      this._connectReject = null;
    }
  }

  _rejectConnect(err) {
    if (this._connectReject) {
      this._connectReject(err);
      this._connectResolve = null;
      this._connectReject = null;
    }
  }

  _emit(event) {
    if (this.onConnectionChange) this.onConnectionChange(event);
  }
}

// Exposed for index.html, which does `new GameTransport()`.
window.GameTransport = GameTransport;
