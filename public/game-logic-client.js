// Mighty Men - Client-side Game Logic
// This is the same as src/game-logic.js but for browser use

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

function isEvil(role) {
  return EVIL_ROLES.includes(role);
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

const GameActions = {
  join(game, playerName) {
    if (game.phase !== GAME_PHASES.LOBBY) {
      throw new Error('Game has already started');
    }
    
    if (game.players.length >= 12) {
      throw new Error('Game is full');
    }
    
    if (game.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      throw new Error('Name already taken');
    }
    
    const newPlayerId = generatePlayerId();
    game.players.push({
      id: newPlayerId,
      name: playerName,
      role: null,
      isHost: false,
      connected: true,
      lastSeen: Date.now()
    });
    game.updatedAt = Date.now();
    
    return { playerId: newPlayerId };
  },
  
  rejoin(game, playerId) {
    const player = game.players.find(p => p.id === playerId);
    if (!player) {
      throw new Error('Player not found in this game');
    }
    
    player.connected = true;
    player.lastSeen = Date.now();
    game.updatedAt = Date.now();
    
    return { playerName: player.name };
  },
  
  start(game, playerId) {
    const player = game.players.find(p => p.id === playerId);
    if (!player || !player.isHost) {
      throw new Error('Only the host can start the game');
    }
    
    if (game.phase !== GAME_PHASES.LOBBY) {
      throw new Error('Game has already started');
    }
    
    if (game.players.length < 6) {
      throw new Error('Need at least 6 players to start');
    }
    
    const roles = assignRoles(game.players.length);
    game.players.forEach((p, i) => {
      p.role = roles[i];
    });
    
    game.leaderIndex = Math.floor(Math.random() * game.players.length);
    game.phase = GAME_PHASES.TEAM_SELECTION;
    game.updatedAt = Date.now();
    
    return { success: true };
  },
  
  propose(game, playerId, team) {
    if (game.phase !== GAME_PHASES.TEAM_SELECTION) {
      throw new Error('Not in team selection phase');
    }
    
    if (game.players[game.leaderIndex]?.id !== playerId) {
      throw new Error('Only the leader can propose a team');
    }
    
    const questSize = QUEST_SIZES[game.currentQuest];
    if (team.length !== questSize) {
      throw new Error(`Team must have exactly ${questSize} players`);
    }
    
    for (const memberId of team) {
      if (!game.players.some(p => p.id === memberId)) {
        throw new Error('Invalid team member');
      }
    }
    
    game.proposedTeam = team;
    game.votes = {};
    game.phase = GAME_PHASES.TEAM_VOTE;
    game.updatedAt = Date.now();
    
    return { success: true };
  },
  
  vote(game, playerId, approve) {
    if (game.phase !== GAME_PHASES.TEAM_VOTE) {
      throw new Error(`Not in voting phase (current phase: ${game.phase})`);
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
      
      game.lastVoteResult = {
        approved: approved,
        approveCount: approveCount,
        rejectCount: rejectCount,
        votes: { ...game.votes },
        team: [...game.proposedTeam]
      };
      
      game.phase = GAME_PHASES.VOTE_RESULT;
    }
    
    return { success: true };
  },
  
  continueFromVote(game, playerId) {
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
    return { success: true };
  },
  
  questVote(game, playerId, success) {
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
    
    let questComplete = false;
    let questResult = null;
    
    if (Object.keys(game.questVotes).length === game.proposedTeam.length) {
      const failCount = Object.values(game.questVotes).filter(v => !v).length;
      const successCount = Object.values(game.questVotes).filter(v => v).length;
      const failsRequired = QUEST_FAIL_REQUIREMENTS[game.currentQuest];
      const questSuccess = failCount < failsRequired;
      
      questResult = {
        success: questSuccess,
        failCount: failCount,
        successCount: successCount,
        team: [...game.proposedTeam]
      };
      
      game.questResults.push(questResult);
      game.phase = GAME_PHASES.QUEST_RESULT;
      questComplete = true;
    }
    
    return { success: true, questComplete, questResult };
  },
  
  continueFromQuest(game, playerId) {
    if (game.phase !== GAME_PHASES.QUEST_RESULT) {
      throw new Error('Not in quest result phase');
    }
    
    const player = game.players.find(p => p.id === playerId);
    if (!player || !player.isHost) {
      throw new Error('Only the host can continue');
    }
    
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
    return { success: true };
  },
  
  assassinate(game, playerId, targetId) {
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
    
    return { success: true };
  }
};

// Export for browser
window.GameLogic = {
  GAME_PHASES,
  ROLES,
  GOOD_ROLES,
  EVIL_ROLES,
  QUEST_SIZES,
  QUEST_FAIL_REQUIREMENTS,
  TEAM_COMPOSITION,
  generateCode,
  generatePlayerId,
  shuffleArray,
  isEvil,
  assignRoles,
  getPlayerKnowledge,
  createGame,
  getPublicGameState,
  GameActions
};
