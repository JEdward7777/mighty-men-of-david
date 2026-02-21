// Mighty Men - CloudFlare Worker (Signaling Only)
// KV is used ONLY for:
// 1. Game code registration (so players can find the game)
// 2. WebRTC signaling (offer/answer/ICE exchange)
// 3. Reconnection by name lookup
// All game state lives in clients' browsers

const GAME_EXPIRY_SECONDS = 7200;  // 2 hours

function generateGameCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  // Serve static files
  if (path === '/' || path === '/index.html') {
    if (env.ASSETS) return env.ASSETS.fetch(request);
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
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}

async function handleApiRequest(path, body, env) {
  
  // Report server mode
  if (path === '/api/mode') {
    return { mode: 'webrtc' };
  }
  
  // Create Game - Host registers a new game code
  if (path === '/api/create') {
    const { name } = body;
    if (!name) throw new Error('Name is required');
    
    const gameCode = generateGameCode();
    const hostId = generatePlayerId();
    
    const gameInfo = {
      code: gameCode,
      hostId: hostId,
      hostName: name,
      createdAt: Date.now(),
      players: [{ id: hostId, name: name, isHost: true }],
      hostSignal: null,
      pendingPlayers: {}
    };
    
    await env.GAMES.put(`game:${gameCode}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true, gameCode, playerId: hostId };
  }
  
  // Check Game - Verify game exists
  if (path === '/api/check') {
    const { code } = body;
    if (!code) throw new Error('Game code is required');
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      return { success: true, exists: false };
    }
    
    const gameInfo = JSON.parse(gameData);
    return {
      success: true,
      exists: true,
      hasHost: !!gameInfo.hostSignal,
      hostName: gameInfo.hostName
    };
  }
  
  // Rejoin by Name - Player reconnects using game code + name
  // If name matches hostName, they are the host
  if (path === '/api/rejoin-by-name') {
    const { code, name } = body;
    if (!code || !name) throw new Error('Game code and name are required');
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    // Check if this is the host by comparing to stored hostName
    const isHost = gameInfo.hostName.toLowerCase() === name.toLowerCase();
    
    if (isHost) {
      // This is the host reconnecting
      return {
        success: true,
        playerId: gameInfo.hostId,
        isHost: true,
        gameCode: gameInfo.code
      };
    }
    
    // Not the host - look for player in players array
    const player = gameInfo.players.find(p => 
      p.name.toLowerCase() === name.toLowerCase() && !p.isHost
    );
    
    if (!player) {
      throw new Error('No player with that name found in this game');
    }
    
    return {
      success: true,
      playerId: player.id,
      isHost: false,
      gameCode: gameInfo.code
    };
  }
  
  // Register Player - Add player to game's lookup list
  if (path === '/api/register-player') {
    const { code, playerId, name } = body;
    if (!code || !playerId || !name) {
      throw new Error('Game code, player ID, and name are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    const existing = gameInfo.players.find(p => p.id === playerId);
    if (!existing) {
      gameInfo.players.push({ id: playerId, name: name, isHost: false });
      
      await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
        expirationTtl: GAME_EXPIRY_SECONDS
      });
    }
    
    return { success: true };
  }
  
  // Host Signal - Host posts WebRTC offer
  if (path === '/api/signal/host') {
    const { code, playerId, signal } = body;
    if (!code || !playerId || !signal) {
      throw new Error('Game code, player ID, and signal are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== playerId) {
      throw new Error('Only the host can post host signal');
    }
    
    gameInfo.hostSignal = { data: signal, timestamp: Date.now() };
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // Get Host Signal - Player retrieves host's offer
  if (path === '/api/signal/get-host') {
    const { code } = body;
    if (!code) throw new Error('Game code is required');
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    if (!gameInfo.hostSignal) {
      return { success: true, signal: null, waiting: true };
    }
    
    return {
      success: true,
      signal: gameInfo.hostSignal.data,
      hostName: gameInfo.hostName,
      hostId: gameInfo.hostId
    };
  }
  
  // Player Signal - Player posts WebRTC offer
  if (path === '/api/signal/player') {
    const { code, playerId, name, signal } = body;
    if (!code || !playerId || !name || !signal) {
      throw new Error('Game code, player ID, name, and signal are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    gameInfo.pendingPlayers[playerId] = {
      name: name,
      offer: signal,        // Player's offer
      answer: null,         // Host will fill this in
      timestamp: Date.now()
    };
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // Get Pending Players - Host polls for new player offers
  if (path === '/api/signal/get-players') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== playerId) {
      throw new Error('Only the host can get pending players');
    }
    
    return { success: true, pendingPlayers: gameInfo.pendingPlayers || {} };
  }
  
  // Host Answer - Host posts answer for a specific player
  if (path === '/api/signal/answer') {
    const { code, playerId, forPlayerId, signal } = body;
    if (!code || !playerId || !forPlayerId || !signal) {
      throw new Error('Game code, player ID, target player ID, and signal are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== playerId) {
      throw new Error('Only the host can post answers');
    }
    
    if (gameInfo.pendingPlayers[forPlayerId]) {
      gameInfo.pendingPlayers[forPlayerId].answer = signal;
    }
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  // Get Answer - Player polls for host's answer
  if (path === '/api/signal/get-answer') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    const pending = gameInfo.pendingPlayers[playerId];
    if (!pending) {
      return { success: true, answer: null, notFound: true };
    }
    
    return { success: true, answer: pending.answer };
  }
  
  // Clear Pending Player - Host removes player after connecting
  if (path === '/api/signal/clear-player') {
    const { code, playerId, clearPlayerId } = body;
    if (!code || !playerId || !clearPlayerId) {
      throw new Error('Game code, player ID, and clear player ID are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) throw new Error('Game not found');
    
    const gameInfo = JSON.parse(gameData);
    
    if (gameInfo.hostId !== playerId) {
      throw new Error('Only the host can clear pending players');
    }
    
    delete gameInfo.pendingPlayers[clearPlayerId];
    
    await env.GAMES.put(`game:${gameInfo.code}`, JSON.stringify(gameInfo), {
      expirationTtl: GAME_EXPIRY_SECONDS
    });
    
    return { success: true };
  }
  
  throw new Error('Unknown API endpoint');
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
