// Local development server that mimics CloudFlare Workers
// Uses shared game logic module

const http = require('http');
const fs = require('fs');
const path = require('path');

// Import shared game logic
const {
  GAME_PHASES,
  ROLES,
  QUEST_SIZES,
  QUEST_FAIL_REQUIREMENTS,
  getPlayerKnowledge,
  createGame,
  getPublicGameState,
  GameActions
} = require('./src/game-logic.js');

// ============ In-memory KV Store ============

const kvStore = new Map();

// Locks for preventing race conditions on game state
const gameLocks = new Map();

async function withGameLock(gameCode, fn) {
  const code = gameCode.toUpperCase();
  
  // Wait for any existing lock
  while (gameLocks.get(code)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  
  // Acquire lock
  gameLocks.set(code, true);
  
  try {
    return await fn();
  } finally {
    // Release lock
    gameLocks.delete(code);
  }
}

// Mock KV environment
const env = {
  GAME_EXPIRY_SECONDS: '7200',
  GAMES: {
    async get(key) {
      const item = kvStore.get(key);
      if (!item) return null;
      if (item.expiry && Date.now() > item.expiry) {
        kvStore.delete(key);
        return null;
      }
      return item.value;
    },
    async put(key, value, options = {}) {
      const item = { value };
      if (options.expirationTtl) {
        item.expiry = Date.now() + (options.expirationTtl * 1000);
      }
      kvStore.set(key, item);
    }
  }
};

// ============ API Request Handler ============

async function handleApiRequest(apiPath, body) {
  const expirationTtl = parseInt(env.GAME_EXPIRY_SECONDS);
  
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
  if (apiPath === '/api/mode') {
    return { mode: 'kv' };
  }
  
  // Create a new game
  if (apiPath === '/api/create') {
    const { name } = body;
    if (!name) {
      throw new Error('Name is required');
    }
    
    const game = createGame(name);
    await saveGame(game);
    
    return {
      success: true,
      gameCode: game.code,
      playerId: game.hostId
    };
  }
  
  // Join an existing game
  if (apiPath === '/api/join') {
    const { code, name } = body;
    if (!code || !name) {
      throw new Error('Game code and name are required');
    }
    
    const game = await getGame(code);
    const result = GameActions.join(game, name);
    await saveGame(game);
    
    return {
      success: true,
      playerId: result.playerId,
      gameCode: game.code
    };
  }
  
  // Rejoin after disconnect
  if (apiPath === '/api/rejoin') {
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
  if (apiPath === '/api/state') {
    const { code, playerId } = body;
    if (!code) {
      throw new Error('Game code is required');
    }
    
    const game = await getGame(code);
    const state = getPublicGameState(game, playerId);
    
    return { success: true, state };
  }
  
  // Get player knowledge (role info)
  if (apiPath === '/api/knowledge') {
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
  if (apiPath === '/api/start') {
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
  if (apiPath === '/api/propose') {
    const { code, playerId, team } = body;
    if (!code || !playerId || !team) {
      throw new Error('Game code, player ID, and team are required');
    }
    
    const game = await getGame(code);
    GameActions.propose(game, playerId, team);
    await saveGame(game);
    
    return { success: true };
  }
  
  // Vote on team (with locking to prevent race conditions)
  if (apiPath === '/api/vote') {
    const { code, playerId, approve } = body;
    if (!code || !playerId || approve === undefined) {
      throw new Error('Game code, player ID, and vote are required');
    }
    
    return await withGameLock(code, async () => {
      const game = await getGame(code);
      
      // Debug logging
      console.log(`[VOTE] Player ${playerId} voting. Phase: ${game.phase}, Players: ${game.players.length}, Votes so far: ${Object.keys(game.votes).length}`);
      
      GameActions.vote(game, playerId, approve);
      await saveGame(game);
      
      console.log(`[VOTE] After vote - Votes: ${Object.keys(game.votes).length}, Players: ${game.players.length}`);
      if (game.phase === GAME_PHASES.VOTE_RESULT) {
        console.log(`[VOTE] All votes in! Transitioned to VOTE_RESULT`);
      }
      
      return { success: true };
    });
  }
  
  // Continue from vote result
  if (apiPath === '/api/continue_vote') {
    const { code, playerId } = body;
    if (!code || !playerId) {
      throw new Error('Game code and player ID are required');
    }
    
    const game = await getGame(code);
    GameActions.continueFromVote(game, playerId);
    await saveGame(game);
    
    return { success: true };
  }
  
  // Submit quest vote (with locking)
  if (apiPath === '/api/quest') {
    const { code, playerId, success } = body;
    if (!code || !playerId || success === undefined) {
      throw new Error('Game code, player ID, and quest vote are required');
    }
    
    return await withGameLock(code, async () => {
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
    });
  }
  
  // Continue from quest result
  if (apiPath === '/api/continue') {
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
  if (apiPath === '/api/assassinate') {
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

// ============ HTTP Server ============

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // API routes
  if (url.pathname.startsWith('/api/')) {
    let body = {};
    
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch (e) {
        body = {};
      }
    }
    
    try {
      const result = await handleApiRequest(url.pathname, body);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (error) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  
  // Static files
  let filePath = url.pathname;
  if (filePath === '/') filePath = '/index.html';
  
  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(filePath);
  
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  
  try {
    const content = fs.readFileSync(fullPath);
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.writeHead(200);
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = process.env.PORT || 12000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Mighty Men game server running at http://localhost:${PORT}`);
  console.log(`   Open in browser to play!`);
});
