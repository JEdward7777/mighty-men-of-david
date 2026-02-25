// WebRTC Transport Layer for Mighty Men
// Full P2P communication - no polling, no server state

// Debug logging
function dbg(category, ...args) {
  const timestamp = new Date().toISOString().substr(11, 12);
  console.log(`[${timestamp}][${category}]`, ...args);
  
  // Also update debug panel if it exists
  const panel = document.getElementById('debug-panel');
  if (panel) {
    const line = document.createElement('div');
    line.textContent = `[${timestamp}][${category}] ${args.map(a => 
      typeof a === 'object' ? JSON.stringify(a) : a
    ).join(' ')}`;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
    // Keep only last 50 lines
    while (panel.children.length > 50) {
      panel.removeChild(panel.firstChild);
    }
  }
}

class WebRTCTransport {
  constructor() {
    dbg('INIT', 'Creating WebRTCTransport');
    this.isHost = false;
    this.gameCode = null;
    this.playerId = null;
    this.playerName = null;
    
    // Game state (host maintains authoritative copy, all have backup)
    this.gameState = null;
    this.stateTimestamp = null;
    
    // WebRTC connections
    this.connections = new Map(); // playerId -> { pc, dataChannel, name, connected }
    this.hostConnection = null;   // For non-host players
    
    // ICE servers (STUN for NAT traversal)
    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
    
    // Callbacks
    this.onStateUpdate = null;      // Called when game state changes
    this.onConnectionChange = null; // Called when player connects/disconnects
    this.onError = null;            // Called on errors
    
    // Signaling polling (only during connection setup)
    this.signalingInterval = null;
    
    // Connection status tracking
    this.disconnectedPlayers = new Set();
    
    // Heartbeat system
    this.heartbeatInterval = null;      // Host broadcasts heartbeat
    this.lastHeartbeatReceived = 0;     // Client tracks when last heartbeat received
    this.heartbeatTimeoutMs = 5000;     // 5 second timeout for client to detect disconnection
    
    // Reconnection backoff
    this.reconnectDelays = [1000, 2000, 4000, 8000, 16000]; // Exponential backoff, capped at 16s
    this.reconnectAttempt = 0;
  }
  
  // ============ Host Functions ============
  
  async createGame(hostName) {
    dbg('HOST', 'createGame called with name:', hostName);
    this.isHost = true;
    this.playerName = hostName;
    
    // Register game with server
    dbg('HOST', 'Calling /api/create');
    const response = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: hostName })
    });
    
    const result = await response.json();
    dbg('HOST', 'Create response:', result);
    if (result.error) throw new Error(result.error);
    
    this.gameCode = result.gameCode;
    this.playerId = result.playerId;
    
    // Initialize game state locally
    dbg('HOST', 'Creating local game state');
    this.gameState = GameLogic.createGame(hostName);
    dbg('HOST', 'Initial gameState:', JSON.stringify(this.gameState).substring(0, 200));
    
    this.gameState.code = this.gameCode;
    this.gameState.hostId = this.playerId;
    this.gameState.players[0].id = this.playerId;
    this.stateTimestamp = Date.now();
    
    dbg('HOST', 'Game state players:', this.gameState.players);
    
    // Start listening for players
    this.startHostSignaling();
    
    return { gameCode: this.gameCode, playerId: this.playerId };
  }
  
  startHostSignaling() {
    dbg('HOST', 'Starting signaling poll interval');
    // Poll for new player signals every 4 seconds
    this.signalingInterval = setInterval(() => this.hostPollForPlayers(), 4000);
    this.hostPollForPlayers(); // Check immediately
    
    // Start heartbeat broadcast
    this.startHeartbeat();
  }
  
  // ============ Heartbeat System ============
  
  startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    // Broadcast heartbeat every 2 seconds so clients know we're alive
    this.heartbeatInterval = setInterval(() => this.hostBroadcastHeartbeat(), 2000);
    dbg('HEARTBEAT', 'Host heartbeat broadcast started');
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  hostBroadcastHeartbeat() {
    // Broadcast heartbeat to all connected players
    const message = { type: 'heartbeat', timestamp: Date.now() };
    for (const [playerId, conn] of this.connections) {
      if (conn.connected && conn.dataChannel?.readyState === 'open') {
        try {
          conn.dataChannel.send(JSON.stringify(message));
        } catch (e) {
          dbg('HEARTBEAT', `Failed to send heartbeat to ${playerId}: ${e.message}`);
        }
      }
    }
  }
  
  // Check if client has received heartbeat recently (called periodically)
  checkHeartbeatTimeout() {
    if (this.isHost) return; // Host doesn't need to check
    
    const now = Date.now();
    const elapsed = now - this.lastHeartbeatReceived;
    
    if (this.lastHeartbeatReceived > 0 && elapsed > this.heartbeatTimeoutMs) {
      dbg('HEARTBEAT', `No heartbeat for ${elapsed}ms, triggering reconnection`);
      this.lastHeartbeatReceived = 0; // Reset to avoid repeated triggers
      this.playerAttemptReconnect();
    }
  }
  
  // Start heartbeat monitoring for clients
  startHeartbeatMonitoring() {
    // Check for heartbeat timeout every second
    setInterval(() => this.checkHeartbeatTimeout(), 1000);
    this.lastHeartbeatReceived = Date.now(); // Initialize
  }
  
  // Finalize state recovery after collecting states from multiple players
  _finalizeStateRecovery() {
    if (!this.gameState) {
      dbg('HOST-MSG', '_finalizeStateRecovery called but no gameState!');
      return;
    }
    
    dbg('HOST-MSG', `Finalizing state recovery, best version: ${this._recoveredStateVersion} from ${this._recoveredStateSender}, phase: ${this.gameState.phase}, players: ${this.gameState.players?.length}`);
    
    // Broadcast recovered state to all connected players
    this.broadcastState();
    
    // Update host UI
    if (this.onStateUpdate) {
      this.onStateUpdate(this.gameState);
    }
    
    // Clear recovery tracking
    this._recoveredStateVersion = null;
    this._recoveredStateSender = null;
  }
  
  async hostPollForPlayers() {
    try {
      const response = await fetch('/api/signal/get-players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: this.gameCode, playerId: this.playerId })
      });
      
      const result = await response.json();
      if (result.error) {
        dbg('HOST-POLL', 'Error:', result.error);
        return;
      }
      
      const pendingCount = Object.keys(result.pendingPlayers || {}).length;
      if (pendingCount > 0) {
        dbg('HOST-POLL', `Found ${pendingCount} pending players`);
      }
      
      // Process each pending player
      for (const [pendingPlayerId, playerData] of Object.entries(result.pendingPlayers || {})) {
        const existingConn = this.connections.get(pendingPlayerId);
        
        // Process if: no connection, OR existing connection is disconnected (reconnection)
        if (!existingConn) {
          dbg('HOST-POLL', `New player: ${playerData.name} (${pendingPlayerId})`);
          await this.hostConnectToPlayer(pendingPlayerId, playerData);
        } else if (!existingConn.connected || existingConn.pc?.connectionState === 'disconnected' || existingConn.pc?.connectionState === 'failed') {
          dbg('HOST-POLL', `Reconnecting player: ${playerData.name} (${pendingPlayerId})`);
          // Clean up old connection
          existingConn.dataChannel?.close();
          existingConn.pc?.close();
          this.connections.delete(pendingPlayerId);
          // Create new connection
          await this.hostConnectToPlayer(pendingPlayerId, playerData);
        }
      }
    } catch (error) {
      dbg('HOST-POLL', 'Exception:', error.message);
    }
  }
  
  async hostConnectToPlayer(playerId, playerData) {
    dbg('HOST-CONN', `Connecting to player: ${playerData.name}`);
    dbg('HOST-CONN', `playerData keys: ${Object.keys(playerData)}`);
    
    // Skip if no offer yet or already have answer
    if (!playerData.offer) {
      dbg('HOST-CONN', 'No offer yet, skipping');
      return;
    }
    if (playerData.answer) {
      dbg('HOST-CONN', 'Already has answer, skipping');
      return;
    }
    
    const pc = new RTCPeerConnection(this.iceServers);
    const connection = { pc, dataChannel: null, name: playerData.name, connected: false };
    this.connections.set(playerId, connection);
    
    dbg('HOST-CONN', 'Created RTCPeerConnection');
    
    pc.oniceconnectionstatechange = () => {
      dbg('HOST-ICE', `ICE state for ${playerData.name}: ${pc.iceConnectionState}`);
    };
    
    pc.onconnectionstatechange = () => {
      dbg('HOST-CONN', `Connection state for ${playerData.name}: ${pc.connectionState}`);
    };
    
    // Host is answerer, so we receive the data channel from player (offerer)
    pc.ondatachannel = (event) => {
      dbg('HOST-CONN', `Received data channel from ${playerData.name}`);
      const dataChannel = event.channel;
      connection.dataChannel = dataChannel;
      
      dataChannel.onopen = () => {
        dbg('HOST-CONN', `Data channel OPEN for ${playerData.name}`);
        connection.connected = true;
        this.disconnectedPlayers.delete(playerId);
        
        // Check if we're in host recovery mode (no gameState yet)
        if (!this.gameState) {
          // Host recovery: skip player matching, just register connection
          dbg('HOST-CONN', `Host recovery mode - deferring player processing until state recovered`);
          
          // Register player in KV for reconnection
          this.registerPlayerInKV(playerId, playerData.name);
          
          // Request state from this player
          dbg('HOST-CONN', `Requesting state from ${playerData.name} (host recovery)`);
          this.sendToPlayer(playerId, { type: 'request-state', yourPlayerId: playerId });
          
          if (this.onConnectionChange) {
            this.onConnectionChange({ type: 'player-connected', playerId, name: playerData.name });
          }
          
          // Clear from pending after successful connection
          fetch('/api/signal/clear-player', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: this.gameCode,
              playerId: this.playerId,
              clearPlayerId: playerId
            })
          });
          return;
        }
        
        // Normal case: we have gameState, process player normally
        // Check if this is a reconnecting player (same name exists)
        const existingPlayer = this.gameState.players.find(
          p => p.name.toLowerCase() === playerData.name.toLowerCase() && p.id !== this.playerId
        );
        
        if (existingPlayer) {
          // Reconnecting player - update their ID and mark connected
          dbg('HOST-CONN', `Reconnecting player: ${playerData.name}, old ID: ${existingPlayer.id}, new ID: ${playerId}`);
          existingPlayer.id = playerId;
          existingPlayer.connected = true;
          existingPlayer.lastSeen = Date.now();
        } else {
          // New player - add to game state
          dbg('HOST-CONN', `New player joining: ${playerData.name}`);
          const joinResult = GameLogic.GameActions.join(this.gameState, playerData.name);
          const newPlayer = this.gameState.players.find(p => p.id === joinResult.playerId);
          if (newPlayer) {
            newPlayer.id = playerId;
          }
        }
        
        this.stateTimestamp = Date.now();
        
        // Register player in KV for reconnection
        this.registerPlayerInKV(playerId, playerData.name);
        
        // DEBUG: Log gameState status before deciding recovery path
        dbg('HOST-CONN', `Data channel OPEN for ${playerData.name}, gameState exists: ${!!this.gameState}, isHostRecovery: ${!this.gameState}`);
        
        if (this.gameState) {
          // Normal case: send current state to player
          dbg('HOST-CONN', `Sending state to ${playerData.name}`);
          this.sendToPlayer(playerId, {
            type: 'state',
            state: this.gameState,
            timestamp: this.stateTimestamp,
            yourPlayerId: playerId
          });
          
          // Notify all other players and update host UI
          this.broadcastState();
          
          if (this.onStateUpdate) {
            this.onStateUpdate(this.gameState);
          }
        } else {
          // Host recovery: request state from this player
          dbg('HOST-CONN', `Requesting state from ${playerData.name} (host recovery)`);
          this.sendToPlayer(playerId, { type: 'request-state', yourPlayerId: playerId });
        }
        
        if (this.onConnectionChange) {
          this.onConnectionChange({ type: 'player-connected', playerId, name: playerData.name });
        }
        
        // Clear from pending after successful connection
        fetch('/api/signal/clear-player', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: this.gameCode,
            playerId: this.playerId,
            clearPlayerId: playerId
          })
        });
      };
      
      dataChannel.onclose = () => {
        dbg('HOST-CONN', `Data channel CLOSED for ${playerData.name}`);
        connection.connected = false;
        this.disconnectedPlayers.add(playerId);
        
        if (this.onConnectionChange) {
          this.onConnectionChange({ type: 'player-disconnected', playerId, name: playerData.name });
        }
      };
      
      dataChannel.onmessage = (event) => {
        this.hostHandleMessage(playerId, JSON.parse(event.data));
      };
    };
    
    // Set remote description (player's offer)
    try {
      dbg('HOST-CONN', 'Setting remote description (player offer)');
      await pc.setRemoteDescription(new RTCSessionDescription(playerData.offer));
      dbg('HOST-CONN', 'Remote description set');
      
      // Create and set answer
      dbg('HOST-CONN', 'Creating answer');
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      dbg('HOST-CONN', 'Local description (answer) set');
      
      // Wait for ICE gathering
      dbg('HOST-CONN', 'Waiting for ICE gathering');
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          pc.onicegatheringstatechange = () => {
            dbg('HOST-ICE', `Gathering state: ${pc.iceGatheringState}`);
            if (pc.iceGatheringState === 'complete') resolve();
          };
          setTimeout(resolve, 5000);
        }
      });
      dbg('HOST-CONN', 'ICE gathering complete');
      
      // Post our answer for this specific player
      dbg('HOST-CONN', 'Posting answer to server');
      await fetch('/api/signal/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: this.gameCode,
          playerId: this.playerId,
          forPlayerId: playerId,
          signal: pc.localDescription
        })
      });
      
      dbg('HOST-CONN', `Posted answer for ${playerData.name}`);
    } catch (error) {
      dbg('HOST-CONN', `ERROR: ${error.message}`);
      console.error(`Error connecting to player ${playerData.name}:`, error);
      this.connections.delete(playerId);
    }
  }
  
  async registerPlayerInKV(playerId, name) {
    try {
      await fetch('/api/register-player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: this.gameCode, playerId, name })
      });
    } catch (error) {
      console.error('Failed to register player:', error);
    }
  }
  
  hostHandleMessage(fromPlayerId, message) {
    dbg('HOST-MSG', `Message from ${fromPlayerId}: ${message.type}`);
    
    switch (message.type) {
      case 'action':
        this.hostHandleAction(fromPlayerId, message.action, message.data);
        break;
      case 'request-state':
        this.sendToPlayer(fromPlayerId, {
          type: 'state',
          state: this.gameState,
          timestamp: this.stateTimestamp,
          yourPlayerId: fromPlayerId
        });
        break;
      case 'state-recovery':
        // Player sending their state for host recovery
        dbg('HOST-MSG', `Received state-recovery from ${fromPlayerId}, version: ${message.state?.version}, phase: ${message.state?.phase}, our state exists: ${!!this.gameState}, our recoveredVersion: ${this._recoveredStateVersion}`);
        
        if (!this.gameState) {
          // First state received - use it as initial candidate
          dbg('HOST-MSG', 'Using first player state as candidate');
          this.gameState = message.state;
          this.stateTimestamp = message.timestamp || Date.now();
          this._recoveredStateVersion = message.state?.version || 0;
          this._recoveredStateSender = fromPlayerId;
          
          // Update host's playerId in the recovered state
          const hostPlayer = this.gameState.players.find(p => p.isHost);
          if (hostPlayer) {
            hostPlayer.id = this.playerId;
          }
          this.gameState.hostId = this.playerId;
          
          dbg('HOST-MSG', `State recovered, phase: ${this.gameState.phase}, players: ${this.gameState.players?.length}, setting 2s timeout to finalize`);
          
          // Set a timeout to finalize state after collecting more candidates
          setTimeout(() => this._finalizeStateRecovery(), 2000);
        } else if (message.state?.version > this._recoveredStateVersion) {
          // This state is newer - update candidate
          dbg('HOST-MSG', `Found newer state (version ${message.state.version} > ${this._recoveredStateVersion}), updating`);
          this.gameState = message.state;
          this._recoveredStateVersion = message.state.version;
          this._recoveredStateSender = fromPlayerId;
          
          // Update host's playerId in the recovered state
          const hostPlayer = this.gameState.players.find(p => p.isHost);
          if (hostPlayer) {
            hostPlayer.id = this.playerId;
          }
          this.gameState.hostId = this.playerId;
        } else {
          dbg('HOST-MSG', `Ignoring state, version ${message.state?.version} <= ${this._recoveredStateVersion}`);
        }
        break;
    }
  }
  
  hostHandleAction(fromPlayerId, action, data) {
    try {
      switch (action) {
        case 'start':
          GameLogic.GameActions.start(this.gameState, fromPlayerId);
          break;
        case 'propose':
          GameLogic.GameActions.propose(this.gameState, fromPlayerId, data.team);
          break;
        case 'vote':
          GameLogic.GameActions.vote(this.gameState, fromPlayerId, data.approve);
          break;
        case 'continueFromVote':
          GameLogic.GameActions.continueFromVote(this.gameState, fromPlayerId);
          break;
        case 'questVote':
          GameLogic.GameActions.questVote(this.gameState, fromPlayerId, data.success);
          break;
        case 'continueFromQuest':
          GameLogic.GameActions.continueFromQuest(this.gameState, fromPlayerId);
          break;
        case 'assassinate':
          GameLogic.GameActions.assassinate(this.gameState, fromPlayerId, data.targetId);
          break;
      }
      
      this.stateTimestamp = Date.now();
      this.broadcastState();
      
      if (this.onStateUpdate) {
        this.onStateUpdate(this.gameState);
      }
    } catch (error) {
      console.error('Action error:', error);
      this.sendToPlayer(fromPlayerId, { type: 'error', message: error.message });
    }
  }
  
  broadcastState() {
    const message = {
      type: 'state',
      state: this.gameState,
      timestamp: this.stateTimestamp
    };
    
    for (const [playerId, conn] of this.connections) {
      if (conn.connected && conn.dataChannel?.readyState === 'open') {
        conn.dataChannel.send(JSON.stringify({ ...message, yourPlayerId: playerId }));
      }
    }
  }
  
  sendToPlayer(playerId, message) {
    const conn = this.connections.get(playerId);
    dbg('SEND', `sendToPlayer to ${conn?.name || playerId}, type: ${message.type}, connected: ${conn?.connected}, readyState: ${conn?.dataChannel?.readyState}`);
    if (conn?.connected && conn.dataChannel?.readyState === 'open') {
      conn.dataChannel.send(JSON.stringify(message));
    } else {
      dbg('SEND', `FAILED to send to ${playerId} - not connected or channel not open`);
    }
  }
  
  // Host performs action on their own game
  doAction(action, data = {}) {
    if (this.isHost) {
      this.hostHandleAction(this.playerId, action, data);
    } else {
      this.sendToHost({ type: 'action', action, data });
    }
  }
  
  // ============ Player Functions ============
  
  async joinGame(gameCode, playerName) {
    this.isHost = false;
    this.gameCode = gameCode.toUpperCase();
    this.playerName = playerName;
    this.playerId = 'p_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    
    // Check game exists
    const checkResponse = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: this.gameCode })
    });
    
    const checkResult = await checkResponse.json();
    if (!checkResult.exists) throw new Error('Game not found');
    
    // Connect to host
    await this.playerConnectToHost();
    
    return { gameCode: this.gameCode, playerId: this.playerId };
  }
  
  async rejoinGame(gameCode, playerName) {
    dbg('REJOIN', `Attempting rejoin: code=${gameCode}, name=${playerName}`);
    this.gameCode = gameCode.toUpperCase();
    this.playerName = playerName;
    
    // Look up player ID by name - server tells us if we're the host
    const response = await fetch('/api/rejoin-by-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: this.gameCode, name: playerName })
    });
    
    const result = await response.json();
    dbg('REJOIN', `Server response:`, result);
    if (result.error) throw new Error(result.error);
    
    this.playerId = result.playerId;
    this.isHost = result.isHost;
    
    dbg('REJOIN', `isHost: ${this.isHost}, playerId: ${this.playerId}`);
    
    if (this.isHost) {
      // Rejoining as host - need to recover state from players
      dbg('REJOIN', 'I am the HOST - starting host rejoin');
      await this.hostRejoin();
    } else {
      // Rejoining as player - connect to host
      dbg('REJOIN', 'I am a PLAYER - connecting to host');
      await this.playerConnectToHost();
    }
    
    return { gameCode: this.gameCode, playerId: this.playerId, isHost: this.isHost };
  }
  
  async hostRejoin() {
    dbg('HOST', 'Host rejoining - will recover state from players');
    this.isHost = true;
    this.gameState = null;  // We lost our state
    this.stateTimestamp = 0;
    this.startHostSignaling();
    
    // Players will reconnect and we'll request state from them
  }
  
  async playerConnectToHost() {
    dbg('PLAYER', 'playerConnectToHost called');
    const pc = new RTCPeerConnection(this.iceServers);
    this.hostConnection = { pc, dataChannel: null, connected: false };
    
    pc.oniceconnectionstatechange = () => {
      dbg('PLAYER-ICE', `ICE state: ${pc.iceConnectionState}`);
    };
    
    pc.onconnectionstatechange = () => {
      dbg('PLAYER-CONN', `Connection state: ${pc.connectionState}`);
    };
    
    // Player is offerer, so WE create the data channel
    dbg('PLAYER', 'Creating data channel');
    const dataChannel = pc.createDataChannel('game');
    this.hostConnection.dataChannel = dataChannel;
    
    dataChannel.onopen = () => {
      dbg('PLAYER', 'Data channel OPEN - connected to host!');
      this.hostConnection.connected = true;
      
      // Reset reconnection attempt counter on successful connection
      this.reconnectAttempt = 0;
      
      // Start heartbeat monitoring to detect future disconnections
      this.startHeartbeatMonitoring();
      
      if (this.onConnectionChange) {
        this.onConnectionChange({ type: 'connected-to-host' });
      }
    };
    
    dataChannel.onclose = () => {
      dbg('PLAYER', 'Data channel CLOSED');
      this.hostConnection.connected = false;
      
      if (this.onConnectionChange) {
        this.onConnectionChange({ type: 'disconnected-from-host' });
      }
      
      // Try to reconnect
      this.playerAttemptReconnect();
    };
    
    dataChannel.onmessage = (event) => {
      dbg('PLAYER', 'Received message from host');
      this.playerHandleMessage(JSON.parse(event.data));
    };
    
    // Create offer
    dbg('PLAYER', 'Creating offer');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    dbg('PLAYER', 'Local description set, waiting for ICE gathering');
    
    // Wait for ICE gathering
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        pc.onicegatheringstatechange = () => {
          dbg('PLAYER-ICE', `Gathering state: ${pc.iceGatheringState}`);
          if (pc.iceGatheringState === 'complete') resolve();
        };
        // Timeout after 10 seconds
        setTimeout(() => {
          dbg('PLAYER-ICE', 'ICE gathering timeout');
          resolve();
        }, 10000);
      }
    });
    
    dbg('PLAYER', 'ICE gathering complete, posting offer');
    
    // Post our offer to server
    const postResult = await fetch('/api/signal/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.gameCode,
        playerId: this.playerId,
        name: this.playerName,
        signal: pc.localDescription
      })
    });
    const postJson = await postResult.json();
    dbg('PLAYER', 'Posted offer, response:', postJson);
    
    // Poll for host's answer
    dbg('PLAYER', 'Waiting for host answer...');
    await this.waitForHostAnswer(pc);
  }
  
  async waitForHostAnswer(pc) {
    const maxAttempts = 30;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        const response = await fetch('/api/signal/get-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: this.gameCode, playerId: this.playerId })
        });
        
        const result = await response.json();
        
        if (result.answer) {
          dbg('PLAYER', 'Got answer from host!');
          console.log('Got answer from host');
          await pc.setRemoteDescription(new RTCSessionDescription(result.answer));
          return;
        }
      } catch (error) {
        console.error('Error polling for answer:', error);
      }
      
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
    
    throw new Error('Timeout waiting for host connection');
  }
  
  playerHandleMessage(message) {
    dbg('PLAYER-MSG', `Received: ${message.type}`);
    
    switch (message.type) {
      case 'heartbeat':
        // Update heartbeat timestamp - host is alive
        this.lastHeartbeatReceived = Date.now();
        dbg('HEARTBEAT', `Received heartbeat, elapsed: ${Date.now() - this.lastHeartbeatReceived}ms`);
        break;
      case 'state':
        dbg('PLAYER-MSG', `Got state, phase: ${message.state?.phase}`);
        this.gameState = message.state;
        this.stateTimestamp = message.timestamp;
        if (message.yourPlayerId) {
          this.playerId = message.yourPlayerId;
        }
        if (this.onStateUpdate) {
          this.onStateUpdate(this.gameState);
        }
        break;
      case 'request-state':
        // Host is requesting our state (host recovery scenario)
        dbg('PLAYER-MSG', `Host requesting state for recovery, our gameState exists: ${!!this.gameState}, phase: ${this.gameState?.phase}`);
        if (message.yourPlayerId) {
          this.playerId = message.yourPlayerId;
        }
        if (this.gameState) {
          dbg('PLAYER-MSG', `Sending our state to host, version: ${this.gameState.version}, players: ${this.gameState.players?.length}`);
          this.sendToHost({
            type: 'state-recovery',
            state: this.gameState,
            timestamp: this.stateTimestamp
          });
        } else {
          dbg('PLAYER-MSG', 'We have no state to send!');
        }
        break;
      case 'error':
        if (this.onError) {
          this.onError(message.message);
        }
        break;
    }
  }
  
  sendToHost(message) {
    if (this.hostConnection?.connected && this.hostConnection.dataChannel?.readyState === 'open') {
      this.hostConnection.dataChannel.send(JSON.stringify(message));
    }
  }
  
  async playerAttemptReconnect() {
    dbg('RECONNECT', `Attempting to reconnect to host (attempt ${this.reconnectAttempt + 1})`);
    
    if (this.onConnectionChange) {
      this.onConnectionChange({ type: 'reconnecting' });
    }
    
    // Calculate delay with exponential backoff and jitter
    const delayIndex = Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1);
    const baseDelay = this.reconnectDelays[delayIndex];
    // Add ±25% jitter
    const jitter = (Math.random() * 0.5 - 0.25) * baseDelay;
    const delay = Math.max(500, Math.round(baseDelay + jitter)); // Minimum 500ms
    
    dbg('RECONNECT', `Waiting ${delay}ms before reconnect attempt`);
    await new Promise(r => setTimeout(r, delay));
    
    try {
      await this.playerConnectToHost();
      dbg('RECONNECT', 'Reconnection successful!');
      this.reconnectAttempt = 0; // Reset on success
    } catch (error) {
      dbg('RECONNECT', `Reconnection failed: ${error.message}`);
      this.reconnectAttempt++;
      // Try again with exponential backoff
      setTimeout(() => this.playerAttemptReconnect(), 0);
    }
  }
  
  // ============ State Access ============
  
  getPublicState() {
    dbg('STATE', `getPublicState called, gameState exists: ${!!this.gameState}, playerId: ${this.playerId}`);
    if (!this.gameState) {
      dbg('STATE', 'No gameState, returning null');
      return null;
    }
    const publicState = GameLogic.getPublicGameState(this.gameState, this.playerId);
    dbg('STATE', `Public state phase: ${publicState?.phase}, players: ${publicState?.players?.length}`);
    return publicState;
  }
  
  getKnowledge() {
    if (!this.gameState) return null;
    return GameLogic.getPlayerKnowledge(this.gameState, this.playerId);
  }
  
  // ============ Connection Status ============
  
  getDisconnectedPlayers() {
    if (!this.isHost) return [];
    return Array.from(this.disconnectedPlayers).map(id => {
      const conn = this.connections.get(id);
      return { id, name: conn?.name || 'Unknown' };
    });
  }
  
  isEveryoneConnected() {
    if (!this.isHost) {
      return this.hostConnection?.connected || false;
    }
    return this.disconnectedPlayers.size === 0;
  }
  
  // ============ Cleanup ============
  
  destroy() {
    if (this.signalingInterval) {
      clearInterval(this.signalingInterval);
    }
    
    // Clean up heartbeat interval
    this.stopHeartbeat();
    
    for (const conn of this.connections.values()) {
      conn.dataChannel?.close();
      conn.pc?.close();
    }
    
    if (this.hostConnection) {
      this.hostConnection.dataChannel?.close();
      this.hostConnection.pc?.close();
    }
  }
}

// Make available globally
window.WebRTCTransport = WebRTCTransport;
