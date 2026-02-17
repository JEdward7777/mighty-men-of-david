// Local development server that mimics CloudFlare Workers
const http = require('http');
const fs = require('fs');
const path = require('path');

// In-memory KV store for development
const kvStore = new Map();

// Mock environment
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
  },
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      let filePath = url.pathname;
      if (filePath === '/') filePath = '/index.html';
      
      const fullPath = path.join(__dirname, 'public', filePath);
      
      try {
        const content = fs.readFileSync(fullPath);
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
        
        return {
          ok: true,
          headers: new Map([['Content-Type', contentTypes[ext] || 'application/octet-stream']]),
          async text() { return content.toString(); },
          async arrayBuffer() { return content; }
        };
      } catch (e) {
        return { ok: false, status: 404 };
      }
    }
  }
};

// Import worker code (we'll inline a modified version for Node.js)
const GAME_PHASES = {
  LOBBY: 'lobby',
  TEAM_SELECTION: 'team_selection',
  TEAM_VOTE: 'team_vote',
  VOTE_RESULT: 'vote_result',
  QUEST: 'quest',
  QUEST_RESULT: 'quest_result',
  ASSASSINATION: 'assassination',
  GAME_OVER: 'game_over'
};

const ROLES = {
  SAMUEL: 'samuel',
  DAVID: 'david',
  MIGHTY_MAN: 'mighty_man',
  SAUL: 'saul',
  PHINEHAS: 'phinehas',
  DOEG: 'doeg',
  SHEEP: 'sheep'
};

const GOOD_ROLES = [ROLES.SAMUEL, ROLES.DAVID, ROLES.MIGHTY_MAN];
const EVIL_ROLES = [ROLES.SAUL, ROLES.PHINEHAS, ROLES.DOEG, ROLES.SHEEP];

const QUEST_SIZES = [3, 4, 5, 6, 6];
const QUEST_FAIL_REQUIREMENTS = [1, 1, 1, 2, 1];

const TEAM_COMPOSITION = {
  6: { good: 4, evil: 2 },
  7: { good: 4, evil: 3 },
  8: { good: 5, evil: 3 },
  9: { good: 6, evil: 3 },
  10: { good: 6, evil: 4 },
  11: { good: 7, evil: 4 },
  12: { good: 8, evil: 4 }
};

function generateCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substring(2, 18);
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function assignRoles(playerCount) {
  const composition = TEAM_COMPOSITION[playerCount] || TEAM_COMPOSITION[Math.min(playerCount, 12)];
  const roles = [];
  
  roles.push(ROLES.SAMUEL);
  roles.push(ROLES.DAVID);
  roles.push(ROLES.SAUL);
  roles.push(ROLES.PHINEHAS);
  
  let goodRemaining = composition.good - 2;
  let evilRemaining = composition.evil - 2;
  
  if (evilRemaining > 0) {
    roles.push(ROLES.DOEG);
    evilRemaining--;
  }
  
  for (let i = 0; i < evilRemaining; i++) {
    roles.push(ROLES.SHEEP);
  }
  
  for (let i = 0; i < goodRemaining; i++) {
    roles.push(ROLES.MIGHTY_MAN);
  }
  
  return shuffleArray(roles);
}

function isEvil(role) {
  return EVIL_ROLES.includes(role);
}

function getPlayerKnowledge(game, playerId) {
  const player = game.players.find(p => p.id === playerId);
  if (!player || !player.role) return null;
  
  const knowledge = {
    role: player.role,
    isEvil: isEvil(player.role),
    sees: []
  };
  
  switch (player.role) {
    case ROLES.SAMUEL:
      knowledge.sees = game.players
        .filter(p => isEvil(p.role) && p.role !== ROLES.SAUL)
        .map(p => ({ id: p.id, name: p.name, label: 'Evil' }));
      break;
      
    case ROLES.DAVID:
      knowledge.sees = game.players
        .filter(p => p.role === ROLES.SAMUEL || p.role === ROLES.PHINEHAS)
        .map(p => ({ id: p.id, name: p.name, label: 'Samuel or Phinehas' }));
      break;
      
    case ROLES.SAUL:
    case ROLES.PHINEHAS:
    case ROLES.SHEEP:
      // Evil players (except Doeg) see all other evil players except Doeg
      knowledge.sees = game.players
        .filter(p => p.id !== playerId && isEvil(p.role) && p.role !== ROLES.DOEG)
        .map(p => ({ id: p.id, name: p.name, label: 'Evil Ally' }));
      break;
      
    case ROLES.DOEG:
    case ROLES.MIGHTY_MAN:
      knowledge.sees = [];
      break;
  }
  
  return knowledge;
}

function createGame(hostName) {
  const gameCode = generateCode();
  const hostId = generatePlayerId();
  
  return {
    code: gameCode,
    phase: GAME_PHASES.LOBBY,
    hostId: hostId,
    players: [{
      id: hostId,
      name: hostName,
      role: null,
      isHost: true,
      connected: true,
      lastSeen: Date.now()
    }],
    currentQuest: 0,
    questResults: [],
    leaderIndex: 0,
    proposedTeam: [],
    votes: {},
    questVotes: {},
    rejectCount: 0,
    assassinationTarget: null,
    winner: null,
    winReason: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function getPublicGameState(game, playerId) {
  const player = game.players.find(p => p.id === playerId);
  const isInGame = !!player;
  
  const publicState = {
    code: game.code,
    phase: game.phase,
    playerCount: game.players.length,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      connected: p.connected,
      role: game.phase === GAME_PHASES.GAME_OVER ? p.role : undefined
    })),
    currentQuest: game.currentQuest,
    questResults: game.questResults,
    questSizes: QUEST_SIZES,
    questFailRequirements: QUEST_FAIL_REQUIREMENTS,
    leaderIndex: game.leaderIndex,
    leaderName: game.players[game.leaderIndex]?.name,
    proposedTeam: game.proposedTeam,
    rejectCount: game.rejectCount,
    winner: game.winner,
    winReason: game.winReason
  };
  
  if (isInGame) {
    publicState.myId = playerId;
    publicState.myName = player.name;
    publicState.isHost = player.isHost;
    publicState.isLeader = game.players[game.leaderIndex]?.id === playerId;
    publicState.isOnTeam = game.proposedTeam.includes(playerId);
    
    if (game.phase === GAME_PHASES.TEAM_VOTE) {
      publicState.votedPlayers = Object.keys(game.votes);
      publicState.hasVoted = game.votes[playerId] !== undefined;
    }
    
    if (game.phase === GAME_PHASES.VOTE_RESULT) {
      publicState.lastVoteResult = game.lastVoteResult;
      // Include player names with their votes
      publicState.voteDetails = game.players.map(p => ({
        id: p.id,
        name: p.name,
        approved: game.lastVoteResult.votes[p.id]
      }));
      publicState.isHost = player.isHost;
    }
    
    if (game.phase === GAME_PHASES.QUEST) {
      publicState.questVotedPlayers = Object.keys(game.questVotes);
      publicState.hasQuestVoted = game.questVotes[playerId] !== undefined;
    }
    
    if (game.phase === GAME_PHASES.ASSASSINATION) {
      const isSaul = player.role === ROLES.SAUL;
      publicState.isSaul = isSaul;
      publicState.assassinationReady = game.assassinationTarget !== null;
    }
    
    if (game.phase === GAME_PHASES.QUEST_RESULT) {
      const lastResult = game.questResults[game.questResults.length - 1];
      publicState.lastQuestResult = lastResult;
      publicState.isHost = player.isHost;
    }
  }
  
  return publicState;
}

async function handleApiRequest(path, body) {
  // Create game
  if (path === '/api/create') {
    const { name } = body;
    if (!name || name.trim().length === 0) {
      throw new Error('Name is required');
    }
    
    const game = createGame(name.trim());
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return {
      success: true,
      gameCode: game.code,
      playerId: game.hostId
    };
  }
  
  // Join game
  if (path === '/api/join') {
    const { code, name } = body;
    if (!code || !name || name.trim().length === 0) {
      throw new Error('Game code and name are required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    
    if (game.phase !== GAME_PHASES.LOBBY) {
      throw new Error('Game has already started');
    }
    
    if (game.players.length >= 12) {
      throw new Error('Game is full');
    }
    
    if (game.players.some(p => p.name.toLowerCase() === name.trim().toLowerCase())) {
      throw new Error('Name already taken');
    }
    
    const playerId = generatePlayerId();
    game.players.push({
      id: playerId,
      name: name.trim(),
      role: null,
      isHost: false,
      connected: true,
      lastSeen: Date.now()
    });
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return {
      success: true,
      gameCode: game.code,
      playerId: playerId
    };
  }
  
  // Rejoin game
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
    const player = game.players.find(p => p.id === playerId);
    
    if (!player) {
      throw new Error('Player not found in this game');
    }
    
    player.connected = true;
    player.lastSeen = Date.now();
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return {
      success: true,
      gameCode: game.code,
      playerId: playerId
    };
  }
  
  // Get game state
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
    
    if (playerId) {
      const player = game.players.find(p => p.id === playerId);
      if (player) {
        player.lastSeen = Date.now();
        player.connected = true;
        await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
          expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
        });
      }
    }
    
    return {
      success: true,
      state: getPublicGameState(game, playerId)
    };
  }
  
  // Get player knowledge
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
    
    if (game.phase === GAME_PHASES.LOBBY) {
      throw new Error('Game has not started yet');
    }
    
    const knowledge = getPlayerKnowledge(game, playerId);
    if (!knowledge) {
      throw new Error('Player not found');
    }
    
    return {
      success: true,
      knowledge: knowledge
    };
  }
  
  // Start game
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
    
    if (game.hostId !== playerId) {
      throw new Error('Only the host can start the game');
    }
    
    if (game.phase !== GAME_PHASES.LOBBY) {
      throw new Error('Game has already started');
    }
    
    if (game.players.length < 6) {
      throw new Error('Need at least 6 players to start');
    }
    
    const roles = assignRoles(game.players.length);
    game.players.forEach((player, index) => {
      player.role = roles[index];
    });
    
    game.leaderIndex = Math.floor(Math.random() * game.players.length);
    game.phase = GAME_PHASES.TEAM_SELECTION;
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return { success: true };
  }
  
  // Propose team
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
    
    if (game.phase !== GAME_PHASES.TEAM_SELECTION) {
      throw new Error('Not in team selection phase');
    }
    
    if (game.players[game.leaderIndex].id !== playerId) {
      throw new Error('Only the leader can propose a team');
    }
    
    const requiredSize = QUEST_SIZES[game.currentQuest];
    if (team.length !== requiredSize) {
      throw new Error(`Team must have exactly ${requiredSize} members`);
    }
    
    const validIds = game.players.map(p => p.id);
    if (!team.every(id => validIds.includes(id))) {
      throw new Error('Invalid team member');
    }
    
    game.proposedTeam = team;
    game.votes = {};
    game.phase = GAME_PHASES.TEAM_VOTE;
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return { success: true };
  }
  
  // Vote on team
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
    
    if (game.phase !== GAME_PHASES.TEAM_VOTE) {
      throw new Error('Not in voting phase');
    }
    
    if (!game.players.some(p => p.id === playerId)) {
      throw new Error('Player not found');
    }
    
    if (game.votes[playerId] !== undefined) {
      throw new Error('Already voted');
    }
    
    game.votes[playerId] = !!approve;
    game.updatedAt = Date.now();
    
    if (Object.keys(game.votes).length === game.players.length) {
      const approveCount = Object.values(game.votes).filter(v => v).length;
      const rejectCount = game.players.length - approveCount;
      const approved = approveCount > game.players.length / 2;
      
      // Store the vote result for display
      game.lastVoteResult = {
        approved: approved,
        approveCount: approveCount,
        rejectCount: rejectCount,
        votes: { ...game.votes }, // Copy the votes so we can show who voted what
        team: [...game.proposedTeam]
      };
      
      // Go to vote result phase to show the outcome
      game.phase = GAME_PHASES.VOTE_RESULT;
    }
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return { success: true };
  }
  
  // Continue from vote result phase
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
    
    if (game.phase !== GAME_PHASES.VOTE_RESULT) {
      throw new Error('Not in vote result phase');
    }
    
    const player = game.players.find(p => p.id === playerId);
    if (!player || !player.isHost) {
      throw new Error('Only the host can continue');
    }
    
    const approved = game.lastVoteResult.approved;
    
    if (approved) {
      game.questVotes = {};
      game.phase = GAME_PHASES.QUEST;
      game.rejectCount = 0;
    } else {
      game.rejectCount++;
      
      if (game.rejectCount >= 5) {
        game.phase = GAME_PHASES.GAME_OVER;
        game.winner = 'evil';
        game.winReason = 'Five consecutive team proposals were rejected';
      } else {
        game.leaderIndex = (game.leaderIndex + 1) % game.players.length;
        game.proposedTeam = [];
        game.votes = {};
        game.phase = GAME_PHASES.TEAM_SELECTION;
      }
    }
    
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return { success: true };
  }
  
  // Submit quest vote
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
    
    if (game.phase !== GAME_PHASES.QUEST) {
      throw new Error('Not in quest phase');
    }
    
    if (!game.proposedTeam.includes(playerId)) {
      throw new Error('You are not on this quest');
    }
    
    const player = game.players.find(p => p.id === playerId);
    
    if (!isEvil(player.role) && !success) {
      throw new Error('Good players must support the quest');
    }
    
    if (game.questVotes[playerId] !== undefined) {
      throw new Error('Already submitted quest vote');
    }
    
    game.questVotes[playerId] = !!success;
    game.updatedAt = Date.now();
    
    if (Object.keys(game.questVotes).length === game.proposedTeam.length) {
      const failCount = Object.values(game.questVotes).filter(v => !v).length;
      const successCount = Object.values(game.questVotes).filter(v => v).length;
      const failsRequired = QUEST_FAIL_REQUIREMENTS[game.currentQuest];
      const questSuccess = failCount < failsRequired;
      
      game.questResults.push({
        success: questSuccess,
        failCount: failCount,
        successCount: successCount,
        team: [...game.proposedTeam]
      });
      
      // Go to quest result phase to show the outcome
      game.phase = GAME_PHASES.QUEST_RESULT;
    }
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    if (Object.keys(game.questVotes).length === game.proposedTeam.length) {
      const lastResult = game.questResults[game.questResults.length - 1];
      return {
        success: true,
        questComplete: true,
        questSuccess: lastResult.success,
        failCount: lastResult.failCount
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
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    
    if (game.phase !== GAME_PHASES.QUEST_RESULT) {
      throw new Error('Not in quest result phase');
    }
    
    const player = game.players.find(p => p.id === playerId);
    if (!player || !player.isHost) {
      throw new Error('Only the host can continue');
    }
    
    // Determine next phase based on results
    const goodWins = game.questResults.filter(r => r.success).length;
    const evilWins = game.questResults.filter(r => !r.success).length;
    
    if (goodWins >= 3) {
      game.phase = GAME_PHASES.ASSASSINATION;
    } else if (evilWins >= 3) {
      game.phase = GAME_PHASES.GAME_OVER;
      game.winner = 'evil';
      game.winReason = 'Three quests failed';
    } else {
      game.currentQuest++;
      game.leaderIndex = (game.leaderIndex + 1) % game.players.length;
      game.proposedTeam = [];
      game.votes = {};
      game.questVotes = {};
      game.phase = GAME_PHASES.TEAM_SELECTION;
    }
    
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return { success: true };
  }
  
  // Assassination
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
    
    if (game.phase !== GAME_PHASES.ASSASSINATION) {
      throw new Error('Not in assassination phase');
    }
    
    const player = game.players.find(p => p.id === playerId);
    if (!player || player.role !== ROLES.SAUL) {
      throw new Error('Only Saul can assassinate');
    }
    
    const target = game.players.find(p => p.id === targetId);
    if (!target) {
      throw new Error('Target not found');
    }
    
    game.assassinationTarget = targetId;
    
    if (target.role === ROLES.SAMUEL) {
      game.winner = 'evil';
      game.winReason = 'Saul correctly identified and eliminated Samuel';
    } else {
      game.winner = 'good';
      game.winReason = 'Samuel survived the assassination attempt';
    }
    
    game.phase = GAME_PHASES.GAME_OVER;
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS)
    });
    
    return { success: true };
  }
  
  throw new Error('Unknown API endpoint');
}

// HTTP Server
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
