// Mighty Men - CloudFlare Worker with KV Storage
// This worker uses CloudFlare KV for game state persistence

import {
  GAME_PHASES,
  ROLES,
  QUEST_SIZES,
  QUEST_FAIL_REQUIREMENTS,
  getPlayerKnowledge,
  createGame,
  getPublicGameState,
  GameActions
} from './game-logic.js';

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

async function handleApiRequest(path, body, env) {
  const expirationTtl = parseInt(env.GAME_EXPIRY_SECONDS || '7200');
  
  // Helper to get and parse game from KV
  async function getGame(code) {
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    return JSON.parse(gameData);
  }
  
  // Helper to save game to KV
  async function saveGame(game) {
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl
    });
  }
  
  // Report server mode
  if (path === '/api/mode') {
    return { mode: 'kv' };
  }
  
  // Create a new game
  if (path === '/api/create') {
    const { hostName } = body;
    if (!hostName) {
      throw new Error('Host name is required');
    }
    
    const game = createGame(hostName);
    await saveGame(game);
    
    return {
      success: true,
      gameCode: game.code,
      playerId: game.hostId
    };
  }
  
  // Join an existing game
  if (path === '/api/join') {
    const { code, playerName } = body;
    if (!code || !playerName) {
      throw new Error('Game code and player name are required');
    }
    
    const game = await getGame(code);
    const result = GameActions.join(game, playerName);
    await saveGame(game);
    
    return {
      success: true,
      playerId: result.playerId,
      gameCode: game.code
    };
  }
  
  // Rejoin after disconnect
  if (path === '/api/rejoin') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const game = await getGame(code);
    const result = GameActions.rejoin(game, playerId);
    await saveGame(game);
    
    return {
      success: true,
      playerName: result.playerName
    };
  }
  
  // Get game state
  if (path === '/api/state') {
    const { code, playerId } = body;
    if (!code) {
      throw new Error('Game code is required');
    }
    
    const game = await getGame(code);
    const state = getPublicGameState(game, playerId);
    
    return { success: true, state };
  }
  
  // Get player knowledge (role info)
  if (path === '/api/knowledge') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const game = await getGame(code);
    const knowledge = getPlayerKnowledge(game, playerId);
    
    if (!knowledge) {
      throw new Error('Player not found or game not started');
    }
    
    return { success: true, knowledge };
  }
  
  // Start the game
  if (path === '/api/start') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const game = await getGame(code);
    GameActions.start(game, playerId);
    await saveGame(game);
    
    return { success: true };
  }
  
  // Propose a team
  if (path === '/api/propose') {
    const { code, playerId, team } = body;
    if (!code || !playerId || !team) {
      throw new Error('Game code, player ID, and team are required');
    }
    
    const game = await getGame(code);
    GameActions.propose(game, playerId, team);
    await saveGame(game);
    
    return { success: true };
  }
  
  // Vote on team
  if (path === '/api/vote') {
    const { code, playerId, approve } = body;
    if (!code || !playerId || approve === undefined) {
      throw new Error('Game code, player ID, and vote are required');
    }
    
    const game = await getGame(code);
    GameActions.vote(game, playerId, approve);
    await saveGame(game);
    
    return { success: true };
  }
  
  // Continue from vote result
  if (path === '/api/continue_vote') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const game = await getGame(code);
    GameActions.continueFromVote(game, playerId);
    await saveGame(game);
    
    return { success: true };
  }
  
  // Submit quest vote
  if (path === '/api/quest') {
    const { code, playerId, success } = body;
    if (!code || !playerId || success === undefined) {
      throw new Error('Game code, player ID, and quest vote are required');
    }
    
    const game = await getGame(code);
    const result = GameActions.questVote(game, playerId, success);
    await saveGame(game);
    
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
  
  // Continue from quest result
  if (path === '/api/continue') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const game = await getGame(code);
    GameActions.continueFromQuest(game, playerId);
    await saveGame(game);
    
    return { success: true };
  }
  
  // Assassination
  if (path === '/api/assassinate') {
    const { code, playerId, targetId } = body;
    if (!code || !playerId || !targetId) {
      throw new Error('Game code, player ID, and target are required');
    }
    
    const game = await getGame(code);
    GameActions.assassinate(game, playerId, targetId);
    await saveGame(game);
    
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
