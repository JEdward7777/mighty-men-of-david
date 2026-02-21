// WebRTC Transport Layer for Mighty Men
// Full P2P communication - no polling, no server state

class WebRTCTransport {
  constructor() {
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
    this.isHost = true;
    this.playerName = hostName;
    
    // Register game with server
    const response = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: hostName })
    });
    
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    
    this.gameCode = result.gameCode;
    this.playerId = result.playerId;
    
    // Initialize game state locally
    this.gameState = GameLogic.createGame(hostName);
    this.gameState.code = this.gameCode;
    this.gameState.hostId = this.playerId;
    this.gameState.players[0].id = this.playerId;
    this.stateTimestamp = Date.now();
    
    // Start listening for players
    this.startHostSignaling();
    
    return { gameCode: this.gameCode, playerId: this.playerId };
  }
  
  startHostSignaling() {
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
      if (result.error) return;
      
      // Process each pending player
      for (const [pendingPlayerId, playerData] of Object.entries(result.pendingPlayers || {})) {
        if (!this.connections.has(pendingPlayerId)) {
          await this.hostConnectToPlayer(pendingPlayerId, playerData);
        }
      }
    } catch (error) {
      console.error('Error polling for players:', error);
    }
  }
  
  async hostConnectToPlayer(playerId, playerData) {
    console.log(`Host connecting to player: ${playerData.name}`);
    
    const pc = new RTCPeerConnection(this.iceServers);
    const connection = { pc, dataChannel: null, name: playerData.name, connected: false };
    this.connections.set(playerId, connection);
    
    // Create data channel
    const dataChannel = pc.createDataChannel('game');
    connection.dataChannel = dataChannel;
    
    dataChannel.onopen = () => {
      console.log(`Connected to player: ${playerData.name}`);
      connection.connected = true;
      this.disconnectedPlayers.delete(playerId);
      
      // Add player to game state
      const joinResult = GameLogic.GameActions.join(this.gameState, playerData.name);
      // Update player ID to match
      const newPlayer = this.gameState.players.find(p => p.id === joinResult.playerId);
      if (newPlayer) {
        newPlayer.id = playerId;
      }
      this.stateTimestamp = Date.now();
      
      // Register player in KV for reconnection
      this.registerPlayerInKV(playerId, playerData.name);
      
      // Send current state to new player
      this.sendToPlayer(playerId, {
        type: 'state',
        state: this.gameState,
        timestamp: this.stateTimestamp,
        yourPlayerId: playerId
      });
      
      // Notify all other players
      this.broadcastState();
      
      if (this.onConnectionChange) {
        this.onConnectionChange({ type: 'player-connected', playerId, name: playerData.name });
      }
    };
    
    dataChannel.onclose = () => {
      console.log(`Player disconnected: ${playerData.name}`);
      connection.connected = false;
      this.disconnectedPlayers.add(playerId);
      
      if (this.onConnectionChange) {
        this.onConnectionChange({ type: 'player-disconnected', playerId, name: playerData.name });
      }
    };
    
    dataChannel.onmessage = (event) => {
      this.hostHandleMessage(playerId, JSON.parse(event.data));
    };
    
    // ICE candidate handling
    pc.onicecandidate = async (event) => {
      if (event.candidate === null) {
        // All candidates gathered, post our answer
        await fetch('/api/signal/host', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: this.gameCode,
            playerId: this.playerId,
            signal: { type: 'answer', sdp: pc.localDescription, forPlayer: playerId }
          })
        });
      }
    };
    
    // Set remote description (player's offer)
    await pc.setRemoteDescription(new RTCSessionDescription(playerData.signal));
    
    // Create and set answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    // Clear this player from pending
    await fetch('/api/signal/clear-player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.gameCode,
        playerId: this.playerId,
        clearPlayerId: playerId
      })
    });
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
    console.log(`Message from ${fromPlayerId}:`, message.type);
    
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
        if (message.timestamp < this.stateTimestamp || !this.gameState) {
          this.gameState = message.state;
          this.stateTimestamp = message.timestamp;
          console.log('Recovered state from player');
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
    this.gameCode = gameCode.toUpperCase();
    this.playerName = playerName;
    
    // Look up player ID by name
    const response = await fetch('/api/rejoin-by-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: this.gameCode, name: playerName })
    });
    
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    
    this.playerId = result.playerId;
    this.isHost = result.isHost;
    
    if (this.isHost) {
      // Rejoining as host - need to recover state from players
      await this.hostRejoin();
    } else {
      // Rejoining as player - connect to host
      await this.playerConnectToHost();
    }
    
    return { gameCode: this.gameCode, playerId: this.playerId, isHost: this.isHost };
  }
  
  async hostRejoin() {
    // Host lost state, need to get it from players
    this.isHost = true;
    this.startHostSignaling();
    
    // Wait for players to reconnect and send state
    // The first player to connect will send their state
  }
  
  async playerConnectToHost() {
    const pc = new RTCPeerConnection(this.iceServers);
    this.hostConnection = { pc, dataChannel: null, connected: false };
    
    // Handle data channel from host
    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      this.hostConnection.dataChannel = dataChannel;
      
      dataChannel.onopen = () => {
        console.log('Connected to host!');
        this.hostConnection.connected = true;
        
        if (this.onConnectionChange) {
          this.onConnectionChange({ type: 'connected-to-host' });
        }
      };
      
      dataChannel.onclose = () => {
        console.log('Disconnected from host');
        this.hostConnection.connected = false;
        
        if (this.onConnectionChange) {
          this.onConnectionChange({ type: 'disconnected-from-host' });
        }
        
        // Try to reconnect
        this.playerAttemptReconnect();
      };
      
      dataChannel.onmessage = (event) => {
        this.playerHandleMessage(JSON.parse(event.data));
      };
    };
    
    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Wait for ICE gathering
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') resolve();
        };
      }
    });
    
    // Post our offer to server
    await fetch('/api/signal/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.gameCode,
        playerId: this.playerId,
        name: this.playerName,
        signal: pc.localDescription
      })
    });
    
    // Poll for host's answer
    await this.waitForHostAnswer(pc);
  }
  
  async waitForHostAnswer(pc) {
    const maxAttempts = 30;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      const response = await fetch('/api/signal/get-host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: this.gameCode })
      });
      
      const result = await response.json();
      
      if (result.signal?.type === 'answer' && result.signal.forPlayer === this.playerId) {
        await pc.setRemoteDescription(new RTCSessionDescription(result.signal.sdp));
        return;
      }
      
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
    
    throw new Error('Timeout waiting for host connection');
  }
  
  playerHandleMessage(message) {
    switch (message.type) {
      case 'state':
        this.gameState = message.state;
        this.stateTimestamp = message.timestamp;
        if (message.yourPlayerId) {
          this.playerId = message.yourPlayerId;
        }
        if (this.onStateUpdate) {
          this.onStateUpdate(this.gameState);
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
    if (!this.gameState) return null;
    return GameLogic.getPublicGameState(this.gameState, this.playerId);
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
