// Mighty Men - A Biblical Social Deduction Game
// CloudFlare Worker Backend

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
  SAMUEL: 'samuel',      // Merlin - knows evil except Saul
  DAVID: 'david',        // Percival - knows Samuel but sees Phinehas too
  MIGHTY_MAN: 'mighty_man', // Loyal servant
  SAUL: 'saul',          // Mordred+Assassin - hidden from Samuel, can assassinate
  PHINEHAS: 'phinehas',  // Morgana - appears to David
  DOEG: 'doeg',          // Oberon - doesn't know evil, evil doesn't know him
  SHEEP: 'sheep'         // Generic evil minion
};

const GOOD_ROLES = [ROLES.SAMUEL, ROLES.DAVID, ROLES.MIGHTY_MAN];
const EVIL_ROLES = [ROLES.SAUL, ROLES.PHINEHAS, ROLES.DOEG, ROLES.SHEEP];

// Quest sizes: always 3, 4, 5, 6, 6
const QUEST_SIZES = [3, 4, 5, 6, 6];
// Quest 4 (index 3) requires 2 fails
const QUEST_FAIL_REQUIREMENTS = [1, 1, 1, 2, 1];

// Player counts: good/evil ratio (standard Avalon)
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
  return 'p_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16);
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
  
  // Always include special roles
  roles.push(ROLES.SAMUEL);  // Good
  roles.push(ROLES.DAVID);   // Good
  roles.push(ROLES.SAUL);    // Evil
  roles.push(ROLES.PHINEHAS); // Evil
  
  let goodRemaining = composition.good - 2;  // Already added Samuel and David
  let evilRemaining = composition.evil - 2;  // Already added Saul and Phinehas
  
  // Add Doeg if we have room for evil
  if (evilRemaining > 0) {
    roles.push(ROLES.DOEG);
    evilRemaining--;
  }
  
  // Fill remaining evil with Sheep
  for (let i = 0; i < evilRemaining; i++) {
    roles.push(ROLES.SHEEP);
  }
  
  // Fill remaining good with Mighty Men
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
      // Sees all evil EXCEPT Saul
      knowledge.sees = game.players
        .filter(p => isEvil(p.role) && p.role !== ROLES.SAUL)
        .map(p => ({ id: p.id, name: p.name, label: 'Evil' }));
      break;
      
    case ROLES.DAVID:
      // Sees Samuel and Phinehas but can't tell them apart
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
      // Knows nothing about other evil
      knowledge.sees = [];
      break;
      
    case ROLES.MIGHTY_MAN:
      // Knows nothing
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
    questResults: [],  // Array of { success: boolean, failCount: number }
    leaderIndex: 0,
    proposedTeam: [],
    votes: {},  // playerId -> boolean (true = approve)
    questVotes: {},  // playerId -> boolean (true = success)
    rejectCount: 0,  // Consecutive rejected teams
    assassinationTarget: null,
    winner: null,  // 'good' or 'evil'
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
      // Only show roles in game over phase
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
  
  // Add player-specific info
  if (isInGame) {
    publicState.myId = playerId;
    publicState.myName = player.name;
    publicState.isHost = player.isHost;
    publicState.isLeader = game.players[game.leaderIndex]?.id === playerId;
    publicState.isOnTeam = game.proposedTeam.includes(playerId);
    
    // Show who has voted (but not what they voted)
    if (game.phase === GAME_PHASES.TEAM_VOTE) {
      publicState.votedPlayers = Object.keys(game.votes);
      publicState.hasVoted = game.votes[playerId] !== undefined;
    }
    
    // Vote result phase - show how everyone voted
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
    
    // Show who has submitted quest vote
    if (game.phase === GAME_PHASES.QUEST) {
      publicState.questVotedPlayers = Object.keys(game.questVotes);
      publicState.hasQuestVoted = game.questVotes[playerId] !== undefined;
    }
    
    // Assassination phase - show to Saul
    if (game.phase === GAME_PHASES.ASSASSINATION) {
      const isSaul = player.role === ROLES.SAUL;
      publicState.isSaul = isSaul;
      publicState.assassinationReady = game.assassinationTarget !== null;
    }
    
    // Quest result phase
    if (game.phase === GAME_PHASES.QUEST_RESULT) {
      const lastResult = game.questResults[game.questResults.length - 1];
      publicState.lastQuestResult = lastResult;
      publicState.isHost = player.isHost;
    }
  }
  
  return publicState;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // CORS headers
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
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Static files not available', { status: 503 });
  }
  
  // API routes
  if (path.startsWith('/api/')) {
    try {
      const result = await handleApiRequest(path, request, env);
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

async function handleApiRequest(path, request, env) {
  const body = request.method === 'POST' ? await request.json() : {};
  
  // Create game
  if (path === '/api/create' && request.method === 'POST') {
    const { name } = body;
    if (!name || name.trim().length === 0) {
      throw new Error('Name is required');
    }
    
    const game = createGame(name.trim());
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return {
      success: true,
      gameCode: game.code,
      playerId: game.hostId
    };
  }
  
  // Join game
  if (path === '/api/join' && request.method === 'POST') {
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
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return {
      success: true,
      gameCode: game.code,
      playerId: playerId
    };
  }
  
  // Rejoin game (using existing player ID)
  if (path === '/api/rejoin' && request.method === 'POST') {
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
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return {
      success: true,
      gameCode: game.code,
      playerId: playerId
    };
  }
  
  // Get game state
  if (path === '/api/state' && request.method === 'POST') {
    const { code, playerId } = body;
    if (!code) {
      throw new Error('Game code is required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    
    // Update last seen
    if (playerId) {
      const player = game.players.find(p => p.id === playerId);
      if (player) {
        player.lastSeen = Date.now();
        player.connected = true;
        await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
          expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
        });
      }
    }
    
    return {
      success: true,
      state: getPublicGameState(game, playerId)
    };
  }
  
  // Get player knowledge (role + who they see)
  if (path === '/api/knowledge' && request.method === 'POST') {
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
  if (path === '/api/start' && request.method === 'POST') {
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
    
    // Assign roles
    const roles = assignRoles(game.players.length);
    game.players.forEach((player, index) => {
      player.role = roles[index];
    });
    
    // Randomize leader order
    game.leaderIndex = Math.floor(Math.random() * game.players.length);
    game.phase = GAME_PHASES.TEAM_SELECTION;
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return { success: true };
  }
  
  // Propose team
  if (path === '/api/propose' && request.method === 'POST') {
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
    
    // Validate all team members exist
    const validIds = game.players.map(p => p.id);
    if (!team.every(id => validIds.includes(id))) {
      throw new Error('Invalid team member');
    }
    
    game.proposedTeam = team;
    game.votes = {};
    game.phase = GAME_PHASES.TEAM_VOTE;
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return { success: true };
  }
  
  // Vote on team
  if (path === '/api/vote' && request.method === 'POST') {
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
    
    // Check if all votes are in
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
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return { success: true };
  }
  
  // Continue from vote result phase
  if (path === '/api/continue_vote' && request.method === 'POST') {
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
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return { success: true };
  }
  
  // Submit quest vote (pass/fail)
  if (path === '/api/quest' && request.method === 'POST') {
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
    
    // Good players must vote success
    if (!isEvil(player.role) && !success) {
      throw new Error('Good players must support the quest');
    }
    
    if (game.questVotes[playerId] !== undefined) {
      throw new Error('Already submitted quest vote');
    }
    
    game.questVotes[playerId] = !!success;
    game.updatedAt = Date.now();
    
    // Check if all quest votes are in
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
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    // Return quest results if all votes are in
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
  
  // Continue from quest result phase
  if (path === '/api/continue' && request.method === 'POST') {
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
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return { success: true };
  }
  
  // Assassination attempt (Saul guesses Samuel)
  if (path === '/api/assassinate' && request.method === 'POST') {
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
      // Evil wins by assassinating Samuel
      game.winner = 'evil';
      game.winReason = 'Saul correctly identified and eliminated Samuel';
    } else {
      // Good wins
      game.winner = 'good';
      game.winReason = 'Samuel survived the assassination attempt';
    }
    
    game.phase = GAME_PHASES.GAME_OVER;
    game.updatedAt = Date.now();
    
    await env.GAMES.put(`game:${game.code}`, JSON.stringify(game), {
      expirationTtl: parseInt(env.GAME_EXPIRY_SECONDS || '7200')
    });
    
    return { success: true };
  }
  
  // Get vote results (after voting is complete)
  if (path === '/api/vote-results' && request.method === 'POST') {
    const { code } = body;
    if (!code) {
      throw new Error('Game code is required');
    }
    
    const gameData = await env.GAMES.get(`game:${code.toUpperCase()}`);
    if (!gameData) {
      throw new Error('Game not found');
    }
    
    const game = JSON.parse(gameData);
    
    // Only return votes if voting is complete (moved to next phase)
    if (game.phase === GAME_PHASES.TEAM_VOTE && Object.keys(game.votes).length < game.players.length) {
      throw new Error('Voting is not complete');
    }
    
    return {
      success: true,
      votes: game.votes,
      players: game.players.map(p => ({ id: p.id, name: p.name }))
    };
  }
  
  throw new Error('Unknown API endpoint');
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
