# Mighty Men of David - Repository Knowledge

## Project Overview
A multiplayer social deduction game inspired by Avalon with a biblical theme. Players use their phones to join games, receive roles, and vote on quests.

## Architecture

### Deployment Modes
The game supports two deployment modes, controlled via `wrangler.toml`:

1. **KV Mode** (`src/worker.js`) - Default
   - All game state stored in Cloudflare KV
   - Clients poll server for state updates
   - Simple, reliable, but more KV operations

2. **WebRTC Mode** (`src/worker-webrtc.js`)
   - Host's browser maintains game state
   - Clients connect via WebRTC data channels
   - KV only used for initial signaling/ICE exchange
   - Reduces KV load, real-time updates

### File Structure
```
src/
  game-logic.js      # Shared game logic (roles, phases, validation)
  worker.js          # KV mode - Cloudflare Worker
  worker-webrtc.js   # WebRTC mode - signaling only
dev-server.js        # Local development server (uses game-logic.js)
public/
  index.html         # Main frontend (supports both modes)
  game-logic-client.js  # Client-side game logic for WebRTC mode
  webrtc-transport.js   # WebRTC connection management
wrangler.toml        # Cloudflare deployment config (mode selection)
```

### Game Flow
1. Host creates game → gets game code
2. Players join with code
3. Host starts game → roles assigned
4. 5 quests, each with:
   - Leader proposes team
   - Everyone votes approve/reject
   - If approved: team members vote pass/fail
   - Track quest successes/failures
5. If good wins 3 quests → Saul can assassinate Samuel
6. Game ends when one side wins

### Character Roles
- **Good**: Samuel (knows evil), David (sees Samuel/Phinehas), Mighty Man
- **Evil**: Saul (hidden, assassin), Phinehas (confuses David), Doeg (lone wolf), Sheep

## Development

### Running Locally
```bash
node dev-server.js
# Server runs at http://localhost:12000
```

### Testing
Open multiple browser tabs to simulate players. Each tab gets a unique player ID via localStorage.

### Deploying to Cloudflare
```bash
# Select mode in wrangler.toml (comment/uncomment main line)
npx wrangler deploy
```

## Key Implementation Details

### Vote Race Condition Fix
The dev server uses game locking (`withGameLock`) to prevent race conditions when multiple players vote simultaneously.

### State Recovery (WebRTC Mode)
- Game state has `createdAt` timestamp
- Clients hold copy of state
- On host reconnect, oldest timestamp wins
- Ensures state lineage is preserved

### Frontend Mode Detection
On page load, frontend calls `/api/mode` to detect KV vs WebRTC mode and uses appropriate transport layer.

## Common Issues

1. **Vote button doesn't work**: Check that `game.votes[playerId] !== undefined` (not `!!value`)
2. **Phase not rendering**: Ensure all phases listed in `updateUI()` switch statement
3. **Selection cleared on poll**: Use persistent state object outside render function

## GitHub Repository
https://github.com/JEdward7777/mighty-men-of-david
