// WebRTC Transport Layer for Mighty Men
// This module handles WebRTC connections and game state synchronization

class WebRTCTransport {
  constructor(turnConfig = null) {
    this.isHost = false;
    this.gameCode = null;
    this.playerId = null;
    this.playerName = null;
    this.hostConnection = null;  // For players: connection to host
    this.playerConnections = {}; // For host: connections to players
    this.gameState = null;
    this.onStateUpdate = null;   // Callback when state changes
    this.onConnectionChange = null; // Callback for connection status
    this.onReconnecting = null;  // Callback for reconnection status
    this.pollingInterval = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    
    // ICE servers configuration (STUN + optional TURN)
    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
    
    // Add TURN servers if provided
    // turnConfig should be: { urls: 'turn:server:port', username: '...', credential: '...' }
    if (turnConfig) {
      if (Array.isArray(turnConfig)) {
        this.iceServers.iceServers.push(...turnConfig);
      } else {
        this.iceServers.iceServers.push(turnConfig);
      }
    }
  }
  
  // ============ Host Functions ============
  
  async createGame(hostName) {
    this.isHost = true;
    this.playerName = hostName;
    
    // Create game on server (get game code and player ID)
    const response = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: hostName })
    });
    
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    
    this.gameCode = result.gameCode;
    this.playerId = result.playerId;
    
    // Create local game state (host manages state locally)
    this.gameState = GameLogic.createGame(hostName);
    this.gameState.code = this.gameCode;
    this.gameState.hostId = this.playerId;
    this.gameState.players[0].id = this.playerId;
    
    // Start listening for new players
    await this.hostStartSignaling();
    
    return {
      gameCode: this.gameCode,
      playerId: this.playerId
    };
  }
  
  async hostStartSignaling() {
    // Create offer for players to connect
    await this.updateHostSignal();
    
    // Poll for new players every 10 seconds
    this.pollingInterval = setInterval(async () => {
      await this.hostPollForPlayers();
    }, 10000);
    
    // Heartbeat: broadcast state to all players every second
    this.heartbeatInterval = setInterval(() => {
      this.hostBroadcastState();
    }, 1000);
    
    // Also poll immediately
    await this.hostPollForPlayers();
  }
  
  async updateHostSignal() {
    // Create a new peer connection for signaling
    // In practice, we'll create individual connections per player
    // For now, just mark that host is available
    const signal = {
      type: 'host-available',
      timestamp: Date.now()
    };
    
    await fetch('/api/signal/host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.gameCode,
        playerId: this.playerId,
        signal: signal
      })
    });
  }
  
  async hostPollForPlayers() {
    try {
      const response = await fetch('/api/signal/get-players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: this.gameCode,
          playerId: this.playerId
        })
      });
      
      const result = await response.json();
      if (result.error) {
        console.error('Error polling for players:', result.error);
        return;
      }
      
      // Process each pending player
      for (const [pendingPlayerId, playerInfo] of Object.entries(result.pendingPlayers || {})) {
        if (!this.playerConnections[pendingPlayerId]) {
          await this.hostConnectToPlayer(pendingPlayerId, playerInfo);
        }
      }
    } catch (error) {
      console.error('Error polling for players:', error);
    }
  }
  
  async hostConnectToPlayer(pendingPlayerId, playerInfo) {
    console.log(`Host connecting to player: ${playerInfo.name}`);
    
    const pc = new RTCPeerConnection(this.iceServers);
    const dataChannel = pc.createDataChannel('gameData');
    
    this.playerConnections[pendingPlayerId] = {
      pc: pc,
      dataChannel: dataChannel,
      name: playerInfo.name,
      connected: false
    };
    
    // Set up data channel handlers
    dataChannel.onopen = () => {
      console.log(`Data channel open with ${playerInfo.name}`);
      this.playerConnections[pendingPlayerId].connected = true;
      
      // If this is a new player (not reconnect), add to game state
      if (!playerInfo.isReconnect) {
        // Add player to local game state
        if (!this.gameState.players.some(p => p.id === pendingPlayerId)) {
          this.gameState.players.push({
            id: pendingPlayerId,
            name: playerInfo.name,
            role: null,
            isHost: false,
            connected: true,
            lastSeen: Date.now()
          });
          this.gameState.updatedAt = Date.now();
        }
      } else {
        // Mark player as reconnected
        const player = this.gameState.players.find(p => p.id === pendingPlayerId);
        if (player) {
          player.connected = true;
          player.lastSeen = Date.now();
        }
      }
      
      // Send current game state to the new player
      this.hostSendStateToPlayer(pendingPlayerId);
      
      // Broadcast updated state to all players
      this.hostBroadcastState();
      
      if (this.onConnectionChange) {
        this.onConnectionChange({ type: 'player-connected', playerId: pendingPlayerId, name: playerInfo.name });
      }
    };
    
    dataChannel.onclose = () => {
      console.log(`Data channel closed with ${playerInfo.name}`);
      this.playerConnections[pendingPlayerId].connected = false;
      
      const player = this.gameState.players.find(p => p.id === pendingPlayerId);
      if (player) {
        player.connected = false;
      }
      
      if (this.onConnectionChange) {
        this.onConnectionChange({ type: 'player-disconnected', playerId: pendingPlayerId, name: playerInfo.name });
      }
    };
    
    dataChannel.onmessage = (event) => {
      this.hostHandleMessage(pendingPlayerId, JSON.parse(event.data));
    };
    
    // Handle ICE candidates
    const iceCandidates = [];
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        iceCandidates.push(event.candidate);
      }
    };
    
    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Wait for ICE gathering to complete
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            resolve();
          }
        };
        // Timeout after 5 seconds
        setTimeout(resolve, 5000);
      }
    });
    
    // Set remote description from player's answer
    const playerSignal = playerInfo.signal;
    if (playerSignal.answer) {
      await pc.setRemoteDescription(new RTCSessionDescription(playerSignal.answer));
      
      // Add player's ICE candidates
      for (const candidate of (playerSignal.iceCandidates || [])) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    }
    
    // Clear the pending player from KV
    await fetch('/api/signal/clear-player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.gameCode,
        hostId: this.playerId,
        clearPlayerId: pendingPlayerId
      })
    });
  }
  
  hostHandleMessage(fromPlayerId, message) {
    console.log(`Host received message from ${fromPlayerId}:`, message.type);
    
    switch (message.type) {
      case 'action':
        this.hostHandleAction(fromPlayerId, message.action, message.data);
        break;
      case 'state-request':
        this.hostSendStateToPlayer(fromPlayerId);
        break;
      case 'state-recovery':
        // Player is sending their state for recovery
        this.hostHandleStateRecovery(message.state);
        break;
    }
  }
  
  hostHandleAction(fromPlayerId, action, data) {
    try {
      let result;
      
      switch (action) {
        case 'join':
          // Already handled during connection
          result = { success: true };
          break;
        case 'start':
          result = GameActions.start(this.gameState, fromPlayerId);
          break;
        case 'propose':
          result = GameActions.propose(this.gameState, fromPlayerId, data.team);
          break;
        case 'vote':
          result = GameActions.vote(this.gameState, fromPlayerId, data.approve);
          break;
        case 'continueFromVote':
          result = GameActions.continueFromVote(this.gameState, fromPlayerId);
          break;
        case 'questVote':
          result = GameActions.questVote(this.gameState, fromPlayerId, data.success);
          break;
        case 'continueFromQuest':
          result = GameActions.continueFromQuest(this.gameState, fromPlayerId);
          break;
        case 'assassinate':
          result = GameActions.assassinate(this.gameState, fromPlayerId, data.targetId);
          break;
        default:
          throw new Error('Unknown action');
      }
      
      // Send result back to player
      this.hostSendToPlayer(fromPlayerId, {
        type: 'action-result',
        action: action,
        result: result
      });
      
      // Broadcast updated state to all players
      this.hostBroadcastState();
      
      // Update local UI
      if (this.onStateUpdate) {
        this.onStateUpdate(this.gameState);
      }
      
    } catch (error) {
      // Send error back to player
      this.hostSendToPlayer(fromPlayerId, {
        type: 'action-error',
        action: action,
        error: error.message
      });
    }
  }
  
  hostHandleStateRecovery(receivedState) {
    // Only accept state if it has an older creation timestamp (same lineage)
    if (receivedState && receivedState.createdAt) {
      if (!this.gameState || receivedState.createdAt < this.gameState.createdAt) {
        console.log('Recovering state from player - older timestamp');
        this.gameState = receivedState;
        this.hostBroadcastState();
        if (this.onStateUpdate) {
          this.onStateUpdate(this.gameState);
        }
      }
    }
  }
  
  hostSendStateToPlayer(playerId) {
    const conn = this.playerConnections[playerId];
    if (conn && conn.connected && conn.dataChannel.readyState === 'open') {
      conn.dataChannel.send(JSON.stringify({
        type: 'state-update',
        state: this.gameState
      }));
    }
  }
  
  hostSendToPlayer(playerId, message) {
    const conn = this.playerConnections[playerId];
    if (conn && conn.connected && conn.dataChannel.readyState === 'open') {
      conn.dataChannel.send(JSON.stringify(message));
    }
  }
  
  hostBroadcastState() {
    const message = JSON.stringify({
      type: 'state-update',
      state: this.gameState
    });
    
    for (const [playerId, conn] of Object.entries(this.playerConnections)) {
      if (conn.connected && conn.dataChannel.readyState === 'open') {
        conn.dataChannel.send(message);
      }
    }
  }
  
  // Host performs an action on their own game state
  hostDoAction(action, data) {
    this.hostHandleAction(this.playerId, action, data);
  }
  
  // ============ Player Functions ============
  
  async joinGame(gameCode, playerName) {
    this.isHost = false;
    this.gameCode = gameCode.toUpperCase();
    this.playerName = playerName;
    
    // Join game via HTTP first (gets server-assigned player ID and validates game exists)
    const joinResponse = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: this.gameCode, name: playerName })
    });
    
    const joinResult = await joinResponse.json();
    if (joinResult.error) {
      throw new Error(joinResult.error);
    }
    
    this.playerId = joinResult.playerId;
    this.gameCode = joinResult.gameCode;
    
    // Now we're registered with the server - state updates will come via polling
    // (In full WebRTC mode, we'd connect to host via WebRTC here)
    // For now, the server handles state so we just return
    
    return {
      gameCode: this.gameCode,
      playerId: this.playerId
    };
  }
  
  async playerConnectToHost() {
    const pc = new RTCPeerConnection(this.iceServers);
    this.hostConnection = { pc: pc, dataChannel: null, connected: false };
    
    // Handle incoming data channel from host
    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      this.hostConnection.dataChannel = dataChannel;
      
      dataChannel.onopen = () => {
        console.log('Connected to host!');
        this.hostConnection.connected = true;
        this.reconnectAttempts = 0;
        
        // Clear reconnecting status
        if (this.onReconnecting) {
          this.onReconnecting({ status: 'connected' });
        }
        
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
        
        // Attempt reconnection
        this.playerAttemptReconnect();
      };
      
      dataChannel.onmessage = (event) => {
        this.playerHandleMessage(JSON.parse(event.data));
      };
    };
    
    // Collect ICE candidates
    const iceCandidates = [];
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        iceCandidates.push(event.candidate);
      }
    };
    
    // Get host's offer (for initial connection, host creates offer)
    // But in our signaling model, player creates answer to host's presence
    // Actually, let's use a simpler model: player posts their info, host initiates
    
    // Wait for ICE gathering
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            resolve();
          }
        };
        setTimeout(resolve, 5000);
      }
    });
    
    // Post our signal to KV for host to pick up
    await fetch('/api/signal/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.gameCode,
        playerId: this.playerId,
        playerName: this.playerName,
        signal: {
          // Player is ready to receive offer from host
          ready: true,
          timestamp: Date.now()
        }
      })
    });
    
    // Wait for connection (host will connect to us)
    // This is handled by the ondatachannel event
  }
  
  async playerAttemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnect attempts reached');
      if (this.onReconnecting) {
        this.onReconnecting({ status: 'failed', attempts: this.reconnectAttempts });
      }
      if (this.onConnectionChange) {
        this.onConnectionChange({ type: 'reconnect-failed' });
      }
      return;
    }
    
    this.reconnectAttempts++;
    console.log(`Attempting reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    // Notify UI that we're reconnecting
    if (this.onReconnecting) {
      this.onReconnecting({ 
        status: 'reconnecting', 
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts
      });
    }
    
    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      await fetch('/api/signal/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: this.gameCode,
          playerId: this.playerId,
          playerName: this.playerName,
          signal: {
            ready: true,
            timestamp: Date.now()
          }
        })
      });
    } catch (error) {
      console.error('Reconnect signal failed:', error);
    }
  }
  
  playerHandleMessage(message) {
    console.log('Player received message:', message.type);
    
    switch (message.type) {
      case 'state-update':
        // Only update if state is older (same lineage) or we don't have state
        if (!this.gameState || message.state.createdAt <= this.gameState.createdAt) {
          this.gameState = message.state;
          if (this.onStateUpdate) {
            this.onStateUpdate(this.gameState);
          }
        }
        break;
      case 'action-result':
        // Action completed successfully
        console.log('Action result:', message.action, message.result);
        break;
      case 'action-error':
        // Action failed
        console.error('Action error:', message.action, message.error);
        alert(message.error);
        break;
    }
  }
  
  // Player sends an action to host
  playerDoAction(action, data = {}) {
    if (!this.hostConnection || !this.hostConnection.connected) {
      throw new Error('Not connected to host');
    }
    
    this.hostConnection.dataChannel.send(JSON.stringify({
      type: 'action',
      action: action,
      data: data
    }));
  }
  
  // Player sends their state to host (for recovery)
  playerSendStateForRecovery() {
    if (this.hostConnection && this.hostConnection.connected && this.gameState) {
      this.hostConnection.dataChannel.send(JSON.stringify({
        type: 'state-recovery',
        state: this.gameState
      }));
    }
  }
  
  // ============ Common Functions ============
  
  getPublicState() {
    if (!this.gameState) return null;
    return getPublicGameState(this.gameState, this.playerId);
  }
  
  getKnowledge() {
    if (!this.gameState) return null;
    return getPlayerKnowledge(this.gameState, this.playerId);
  }
  
  // Perform an action (routes to host or player method)
  doAction(action, data = {}) {
    if (this.isHost) {
      this.hostDoAction(action, data);
    } else {
      this.playerDoAction(action, data);
    }
  }
  
  // Clean up connections
  disconnect() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.hostConnection && this.hostConnection.pc) {
      this.hostConnection.pc.close();
    }
    
    for (const conn of Object.values(this.playerConnections)) {
      if (conn.pc) {
        conn.pc.close();
      }
    }
  }
}

// Import game logic for host-side actions
// This will be available when the script is loaded after game-logic.js
let GameActions, getPublicGameState, getPlayerKnowledge;

// Initialize when game-logic is available
function initWebRTCTransport(gameLogic) {
  GameActions = gameLogic.GameActions;
  getPublicGameState = gameLogic.getPublicGameState;
  getPlayerKnowledge = gameLogic.getPlayerKnowledge;
}

// Export for use in main app
window.WebRTCTransport = WebRTCTransport;
window.initWebRTCTransport = initWebRTCTransport;
