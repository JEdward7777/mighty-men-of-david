# Mighty Men of David

A biblical-themed social deduction game inspired by Avalon. Players take on the roles of David's loyal followers or Saul's treacherous servants in a battle of wits and deception.

## 🎮 How to Play

### Overview
- **6-12 players** gather in person, each using their phone as their game interface
- Players are secretly assigned roles - either **Good** (David's side) or **Evil** (Saul's side)
- The game consists of **5 quests** that teams must complete
- **Good wins** by completing 3 quests successfully
- **Evil wins** by failing 3 quests OR by Saul correctly identifying Samuel at the end

### Characters

#### Good (Loyal to David)
| Character | Ability |
|-----------|---------|
| **Samuel** | Knows all evil players EXCEPT Saul |
| **David** | Sees Samuel and Phinehas but can't tell them apart |
| **Mighty Men** | Loyal servants with no special knowledge |

#### Evil (Servants of Saul)
| Character | Ability |
|-----------|---------|
| **Saul** | Hidden from Samuel. Knows evil allies (except Doeg). Can assassinate Samuel at the end |
| **Phinehas** | Appears to David as possibly Samuel. Knows evil allies (except Doeg) |
| **Doeg** | Works alone - doesn't know other evil players |
| **Sheep of Saul** | Know their evil allies (except Doeg) |

### Quest Sizes
| Quest | Team Size | Fails Required |
|-------|-----------|----------------|
| 1 | 3 | 1 |
| 2 | 4 | 1 |
| 3 | 5 | 1 |
| 4 | 6 | **2** |
| 5 | 6 | 1 |

### Game Flow
1. **Lobby**: One player creates a game and shares the code/QR. Others join with the code.
2. **Role Assignment**: The host starts the game. Roles are secretly assigned.
3. **Quest Rounds**:
   - The current leader proposes a team
   - Everyone votes to approve/reject the team
   - If approved, team members secretly choose success/fail
   - If 5 teams are rejected in a row, Evil wins immediately
4. **Assassination**: If Good wins 3 quests, Saul gets one chance to identify Samuel

## 🛠️ Technical Setup

### Prerequisites
- Node.js 18+
- Wrangler CLI (for CloudFlare Workers)

### Local Development

```bash
# Install dependencies
npm install

# Run local development server
node dev-server.js
```

The game will be available at `http://localhost:12000`

### Deploy to CloudFlare Workers

1. Create a KV namespace in CloudFlare dashboard
2. Update `wrangler.toml` with your KV namespace IDs:

```toml
[[kv_namespaces]]
binding = "GAMES"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"
```

3. Deploy:

```bash
npm run deploy
```

## 📁 Project Structure

```
mighty-men-game/
├── public/
│   └── index.html      # Frontend (single-page app)
├── src/
│   └── worker.js       # CloudFlare Worker backend
├── dev-server.js       # Local development server
├── wrangler.toml       # CloudFlare configuration
└── package.json
```

## 🎨 Features

- **Ancient/Biblical aesthetic** with parchment textures and classic typography
- **QR code** for easy game joining
- **Hold-to-reveal** role cards for security
- **Real-time updates** via polling
- **Sound alerts** when it's your turn to act
- **Session persistence** - rejoin if you close your browser
- **Mobile-optimized** touch-friendly interface

## 🔧 Configuration

Environment variables in `wrangler.toml`:

| Variable | Description | Default |
|----------|-------------|---------|
| `GAME_EXPIRY_SECONDS` | How long games persist | 7200 (2 hours) |

## 📝 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/create` | POST | Create new game |
| `/api/join` | POST | Join existing game |
| `/api/rejoin` | POST | Rejoin with saved session |
| `/api/state` | POST | Get current game state |
| `/api/knowledge` | POST | Get player's role and knowledge |
| `/api/start` | POST | Start the game (host only) |
| `/api/propose` | POST | Propose quest team |
| `/api/vote` | POST | Vote on proposed team |
| `/api/quest` | POST | Submit quest success/fail |
| `/api/assassinate` | POST | Saul's assassination attempt |

## 🎯 Role Distribution

| Players | Good | Evil |
|---------|------|------|
| 6 | 4 | 2 |
| 7 | 4 | 3 |
| 8 | 5 | 3 |
| 9 | 6 | 3 |
| 10 | 6 | 4 |
| 11 | 7 | 4 |
| 12 | 8 | 4 |

Special roles (Samuel, David, Saul, Phinehas) are always included. Doeg is added when there are 3+ evil players.

## 📜 License

MIT License - Feel free to use and modify!

---

*"The LORD is my light and my salvation—whom shall I fear?"* - Psalm 27:1
