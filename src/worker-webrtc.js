// Mighty Men - CloudFlare Worker with WebRTC Signaling
// This worker only handles WebRTC signaling via KV
// Game state is managed by the host's browser via WebRTC data channels

import {
  GAME_PHASES,
  createGame,
  getPublicGameState,
  getPlayerKnowledge,
  GameActions
} from './game-logic.js';

// ============ Constants ============

const SIGNAL_EXPIRY_SECONDS = 300; // 5 minutes for signaling data
const GAME_EXPIRY_SECONDS = 7200;  // 2 hours for game metadata

// ============ Request Handler ============

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  // Serve static files
  if (path === '/' || path === '/index.html') {
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Static files not available', { status: 503 });
  }
  
  // API routes
  if (path.startsWith('/api/')) {
    try {
      let body = {};
      if (request.method === 'POST') {
        body = await request.json();
      }
      
      const result = await handleApiRequest(path, body, env);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Serve other static assets
  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  return new Response('Static files not available', { status: 503 });
}

// ============ API Request Handler ============
// In WebRTC mode, KV is only used for:
// 1. Game creation (storing host info)
// 2. WebRTC signaling (ICE exchange)
// 3. Reconnection signaling

async function handleApiRequest(path, body, env) {
  
  // Report server mode
  if (path === '/api/mode') {
    return { mode: 'webrtc' };
  }
  
  // ============ Game Creation ============
  // Host creates a game and registers in KV
  if (path === '/api/create') {
    const { name } = body;
    if (!name) {
      throw new Error('Name is required');
    }
    
    // Create game structure (host will maintain full state)
    const game = createGame(name);
    
    // Store full game state in KV (WebRTC mode still uses KV as backup)
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return {
      success: true,
      gameCode: game.code,
      playerId: game.hostId
    };
  }
  
  // ============ Join Game ============
  if (path === '/api/join') {
    const { code, name } = body;
    if (!code || !name) {
      throw new Error('Game code and name are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    const result = GameActions.join(game, name);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return {
      success: true,
      playerId: result.playerId,
      gameCode: game.code
    };
  }
  
  // ============ Rejoin Game ============
  if (path === '/api/rejoin') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    const result = GameActions.rejoin(game, playerId);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return {
      success: true,
      playerName: result.playerName,
      gameCode: game.code,
      playerId: playerId
    };
  }
  
  // ============ Get Game State ============
  if (path === '/api/state') {
    const { code, playerId } = body;
    if (!code) {
      throw new Error('Game code is required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    const state = getPublicGameState(game, playerId);
    
    return { success: true, state };
  }
  
  // ============ Get Player Knowledge ============
  if (path === '/api/knowledge') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    const knowledge = getPlayerKnowledge(game, playerId);
    
    if (!knowledge) {
      throw new Error('Player not found or game not started');
    }
    
    return { success: true, knowledge };
  }
  
  // ============ Start Game ============
  if (path === '/api/start') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    GameActions.start(game, playerId);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Propose Team ============
  if (path === '/api/propose') {
    const { code, playerId, team } = body;
    if (!code || !playerId || !team) {
      throw new Error('Game code, player ID, and team are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    GameActions.propose(game, playerId, team);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Vote on Team ============
  if (path === '/api/vote') {
    const { code, playerId, approve } = body;
    if (!code || !playerId || approve === undefined) {
      throw new Error('Game code, player ID, and vote are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    GameActions.vote(game, playerId, approve);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Continue from Vote Result ============
  if (path === '/api/continue_vote') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    GameActions.continueFromVote(game, playerId);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Quest Vote ============
  if (path === '/api/quest') {
    const { code, playerId, success } = body;
    if (!code || !playerId || success === undefined) {
      throw new Error('Game code, player ID, and quest vote are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    const result = GameActions.questVote(game, playerId, success);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    if (result.questComplete) {
      return {
        success: true,
        questComplete: true,
        questSuccess: result.questResult.success,
        failCount: result.questResult.failCount
      };
    }
    
    return { success: true };
  }
  
  // ============ Continue from Quest Result ============
  if (path === '/api/continue') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    GameActions.continueFromQuest(game, playerId);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Assassination ============
  if (path === '/api/assassinate') {
    const { code, playerId, targetId } = body;
    if (!code || !playerId || !targetId) {
      throw new Error('Game code, player ID, and target are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    GameActions.assassinate(game, playerId, targetId);
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Host Signal Registration ============
  // Host posts their WebRTC offer/ICE candidates
  if (path === '/api/signal/host') {
    const { code, playerId, signal } = body;
    if (!code || !playerId || !signal) {
      throw new Error('Game code, player ID, and signal are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== playerId) {
      throw new Error('Only the host can post host signal');
    }
    
    gameInfo.hostSignal = {
      data: signal,
      timestamp: Date.now()
    };
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Get Host Signal ============
  // Players retrieve host's signal to initiate connection
  if (path === '/api/signal/get-host') {
    const { code } = body;
    if (!code) {
      throw new Error('Game code is required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const gameInfo = JSON.parse(gameData);
    
    if (!gameInfo.hostSignal) {
      return { success: true, signal: null, waiting: true };
    }
    
    return {
      success: true,
      signal: gameInfo.hostSignal.data,
      hostName: gameInfo.hostName
    };
  }
  
  // ============ Player Signal Registration ============
  // Player posts their WebRTC answer/ICE candidates
  if (path === '/api/signal/player') {
    const { code, playerId, playerName, signal } = body;
    if (!code || !playerId || !playerName || !signal) {
      throw new Error('Game code, player ID, player name, and signal are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const gameInfo = JSON.parse(gameData);
    
    gameInfo.pendingPlayers[playerId] = {
      name: playerName,
      signal: signal,
      timestamp: Date.now()
    };
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Get Pending Players ============
  // Host polls for new player signals
  if (path === '/api/signal/get-players') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== playerId) {
      throw new Error('Only the host can get pending players');
    }
    
    return {
      success: true,
      pendingPlayers: gameInfo.pendingPlayers
    };
  }
  
  // ============ Clear Pending Player ============
  // Host clears a player after successful connection
  if (path === '/api/signal/clear-player') {
    const { code, hostId, clearPlayerId } = body;
    if (!code || !hostId || !clearPlayerId) {
      throw new Error('Game code, host ID, and player ID to clear are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== hostId) {
      throw new Error('Only the host can clear pending players');
    }
    
    delete gameInfo.pendingPlayers[clearPlayerId];
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Check Game Exists ============
  // Quick check if a game code is valid
  if (path === '/api/check') {
    const { code } = body;
    if (!code) {
      throw new Error('Game code is required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    
    return {
      success: true,
      exists: !!gameData,
      hasHost: gameData ? !!JSON.parse(gameData).hostSignal : false
    };
  }
  
  // ============ Reconnection Support ============
  // Player requests reconnection (posts new signal)
  if (path === '/api/signal/reconnect') {
    const { code, playerId, playerName, signal } = body;
    if (!code || !playerId || !signal) {
      throw new Error('Game code, player ID, and signal are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const gameInfo = JSON.parse(gameData);
    
    // Add to pending players for reconnection
    gameInfo.pendingPlayers[playerId] = {
      name: playerName || 'Reconnecting...',
      signal: signal,
      timestamp: Date.now(),
      isReconnect: true
    };
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // ============ Host Reconnection ============
  // Host posts new signal after reconnection
  if (path === '/api/signal/host-reconnect') {
    const { code, playerId, signal } = body;
    if (!code || !playerId || !signal) {
      throw new Error('Game code, player ID, and signal are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== playerId) {
      throw new Error('Only the host can post host signal');
    }
    
    gameInfo.hostSignal = {
      data: signal,
      timestamp: Date.now(),
      isReconnect: true
    };
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }

  throw new Error('Unknown API endpoint');
}

// ============ Export ============

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
