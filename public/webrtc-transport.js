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
    // Poll for new player signals every 2 seconds
    this.signalingInterval = setInterval(() => this.hostPollForPlayers(), 2000);
    this.hostPollForPlayers(); // Check immediately
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
        dbg('HOST-MSG', `Received state-recovery, our state: ${!!this.gameState}`);
        if (!this.gameState) {
          dbg('HOST-MSG', 'Using player state for recovery');
          this.gameState = message.state;
          this.stateTimestamp = message.timestamp || Date.now();
          
          // Update host's playerId in the recovered state
          const hostPlayer = this.gameState.players.find(p => p.isHost);
          if (hostPlayer) {
            hostPlayer.id = this.playerId;
          }
          this.gameState.hostId = this.playerId;
          
          // Now broadcast recovered state to all connected players
          this.broadcastState();
          
          // Update host UI
          if (this.onStateUpdate) {
            this.onStateUpdate(this.gameState);
          }
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
    if (conn?.connected && conn.dataChannel?.readyState === 'open') {
      conn.dataChannel.send(JSON.stringify(message));
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
        dbg('PLAYER-MSG', 'Host requesting state for recovery');
        if (message.yourPlayerId) {
          this.playerId = message.yourPlayerId;
        }
        if (this.gameState) {
          dbg('PLAYER-MSG', 'Sending our state to host');
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
    console.log('Attempting to reconnect to host...');
    
    if (this.onConnectionChange) {
      this.onConnectionChange({ type: 'reconnecting' });
    }
    
    // Wait a bit then try again
    await new Promise(r => setTimeout(r, 2000));
    
    try {
      await this.playerConnectToHost();
    } catch (error) {
      console.error('Reconnection failed:', error);
      // Try again
      setTimeout(() => this.playerAttemptReconnect(), 5000);
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
