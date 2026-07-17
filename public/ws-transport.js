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
    this.playerName = null;
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

    // Heartbeat: the client pings every _heartbeatIntervalMs; the server (or
    // rather the Workers runtime, via setWebSocketAutoResponse) answers 'pong'.
    // Any message counts as proof of life. If nothing arrives for
    // _heartbeatTimeoutMs the socket is presumed silently dead — phones dropping
    // Wi-Fi or sleeping often kill connections without ever firing a close event.
    this._lastPong = 0;
    this._heartbeatTimer = null;
    this._heartbeatIntervalMs = 25000;
    this._heartbeatTimeoutMs = 60000;

    // Reconnect promptly when the tab returns to the foreground.
    this._onVisibility = () => {
      if (document.visibilityState === 'visible') this._checkAliveNow();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  // ============ Identity persistence (per game code + name) ============
  //
  // Keyed by code AND name because tabs in the same browser share localStorage.
  // If it were keyed by code alone, a second tab joining under a different name
  // would find the first player's token and reconnect *as that player* instead
  // of joining fresh.

  _identityKey(code, name) {
    return `mightymen_id_${code.toUpperCase()}_${encodeURIComponent((name || '').toLowerCase())}`;
  }

  _saveIdentity() {
    if (!this.gameCode || !this.playerName || !this.playerId || !this.token) return;
    try {
      localStorage.setItem(
        this._identityKey(this.gameCode, this.playerName),
        JSON.stringify({ playerId: this.playerId, token: this.token })
      );
    } catch { /* storage unavailable */ }
  }

  _loadIdentity(code, name) {
    try {
      const raw = localStorage.getItem(this._identityKey(code, name));
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
    this.playerName = hostName;
    this.playerId = result.playerId;
    this.token = result.token;
    this.isHost = true;
    this._saveIdentity();

    await this._connect({ playerId: this.playerId, token: this.token });
    return { gameCode: this.gameCode, playerId: this.playerId };
  }

  async joinGame(gameCode, playerName) {
    this.gameCode = gameCode.toUpperCase();
    this.playerName = playerName;
    await this._connect({ name: playerName });
    return { gameCode: this.gameCode, playerId: this.playerId };
  }

  async rejoinGame(gameCode, playerName) {
    const code = gameCode.toUpperCase();
    this.gameCode = code;
    this.playerName = playerName;
    // Always send the name so the server can reclaim the seat by name from any
    // browser (or after the saved token was lost). Include the saved token when
    // we have one so a same-browser reconnect keeps its id without rotating it.
    const hello = { name: playerName };
    const identity = this._loadIdentity(code, playerName);
    if (identity) {
      this.playerId = identity.playerId;
      this.token = identity.token;
      hello.playerId = identity.playerId;
      hello.token = identity.token;
    }
    await this._connect(hello);
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
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this.ws) {
      this._teardownSocket(this.ws);
      this.ws = null;
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

      // Replace any previous socket outright: detach its handlers first so a
      // late close/message event from it can never touch the new connection.
      if (this.ws) {
        this._teardownSocket(this.ws);
        this.ws = null;
      }

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
          if (this.ws === ws) this.ws = null;
          this._teardownSocket(ws);
          this._rejectConnect(new Error('Timeout connecting to game'));
        }
      }, 15000);

      // Every handler below ignores events from a socket that is no longer the
      // current one (this.ws !== ws) — a stale socket's dying gasps must not
      // clobber a newer connection.
      ws.onopen = () => {
        if (this.ws !== ws) return;
        dbg('WS', 'Open, sending hello');
        this._send({ type: 'hello', ...this._hello });
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        clearTimeout(timeout);
        this._lastPong = Date.now(); // any message is proof of life
        if (event.data === 'pong') return; // heartbeat reply
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        this._handleMessage(msg);
      };

      ws.onclose = () => {
        if (this.ws !== ws) return; // stale socket; already replaced
        dbg('WS', 'Closed');
        clearTimeout(timeout);
        this._handleClose();
      };

      ws.onerror = (e) => {
        dbg('WS', 'Error', e && e.message);
      };
    });
  }

  // Detach a socket's handlers and close it, so it can neither fire events nor
  // linger half-open.
  _teardownSocket(ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
  }

  // ============ Heartbeat / liveness ============

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._lastPong = Date.now();
    this._heartbeatTimer = setInterval(() => this._heartbeatTick(), this._heartbeatIntervalMs);
  }

  _heartbeatTick() {
    if (this._intentionalClose) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Not open, and nobody is working on it → treat as dead. This covers a
      // socket stuck in CLOSING whose close event never fires.
      if (this.ws && !this._reconnecting && !this._connectResolve) this._presumeDead();
      return;
    }
    if (Date.now() - this._lastPong > this._heartbeatTimeoutMs) {
      dbg('WS', 'Heartbeat timeout — presuming connection dead');
      this._presumeDead();
      return;
    }
    try { this.ws.send('ping'); } catch { /* socket is on its way out */ }
  }

  // Tear down a socket we believe is silently dead and start reconnecting.
  _presumeDead() {
    const ws = this.ws;
    this.ws = null;
    if (ws) this._teardownSocket(ws);
    if (this._intentionalClose) return;
    this._emit({ type: 'disconnected-from-host' });
    if (!this._reconnecting) this._scheduleReconnect();
  }

  // Called when the tab returns to the foreground: phones often kill background
  // sockets without a close event, so verify the connection right away.
  _checkAliveNow() {
    if (this._intentionalClose || !this.gameCode) return;
    if (this._reconnecting || this._connectResolve) return; // already (re)connecting
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      dbg('WS', 'Tab visible and socket not open — reconnecting');
      this._reconnectAttempt = 0; // the user is looking; retry promptly
      this._scheduleReconnect();
      return;
    }
    // The socket claims to be open — verify with a quick ping.
    const before = this._lastPong;
    try { this.ws.send('ping'); } catch { this._presumeDead(); return; }
    setTimeout(() => {
      if (this._intentionalClose || this._reconnecting || this._connectResolve) return;
      if (this._lastPong === before && this.ws && this.ws.readyState === WebSocket.OPEN) {
        dbg('WS', 'No pong after tab wake — presuming connection dead');
        this._reconnectAttempt = 0;
        this._presumeDead();
      }
    }, 4000);
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
          this._startHeartbeat();
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

      case 'removed':
        // The host removed us. Don't try to reconnect; let the UI bail out.
        this._intentionalClose = true;
        this._emit({ type: 'removed', message: msg.message });
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
      // Include the name alongside the token: if our token was rotated (the seat
      // was reclaimed from another device), the server falls back to a name
      // reclaim instead of rejecting us forever with "Unknown player".
      await this._connect({
        name: this.playerName || undefined,
        playerId: this.playerId,
        token: this.token
      });
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
      try {
        this.ws.send(JSON.stringify(obj));
        return;
      } catch (e) {
        dbg('WS', 'Send threw:', e && e.message);
      }
    } else {
      dbg('WS', 'Cannot send, socket not open:', obj.type);
    }
    // The message could not be delivered — most likely a player tapped a button
    // on a silently dead connection. Don't swallow it: show the reconnecting
    // banner and start recovering immediately so a retry works in a moment.
    if (this._intentionalClose || !this.gameCode) return;
    this._emit({ type: 'disconnected-from-host' });
    this._checkAliveNow();
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
