// Mighty Men of David - Cloudflare Worker + Durable Object
//
// Architecture (replaces the old WebRTC peer-to-peer transport):
//   - One `GameRoom` Durable Object per game code holds the authoritative state.
//   - Players connect over a WebSocket and receive a *per-player filtered* view of
//     the game (secret roles are never sent to other players).
//   - The Worker only routes: it creates games (with collision-free codes) and
//     upgrades WebSocket connections to the right DO.
//
// See harness/DURABLE-OBJECTS-MIGRATION.md for the full rationale.

import { DurableObject } from 'cloudflare:workers';
import {
  createGame,
  getPublicGameState,
  getPlayerKnowledge,
  normalizeName,
  GameActions
} from './game-logic.js';

const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60; // used if the env var is missing/invalid
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

// Cryptographically-random game code (no ambiguous chars).
function generateGameCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

// ============================================================
// Durable Object: one instance per game code
// ============================================================

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = null;        // authoritative game state (from game-logic.js)
    this.secrets = {};       // { [playerId]: token } — never sent to clients
    // Inactivity expiry, configurable via wrangler.toml [vars].
    const configured = Number(env.GAME_EXPIRY_SECONDS);
    this.expiryMs = (configured > 0 ? configured : DEFAULT_EXPIRY_SECONDS) * 1000;
    // Answer client heartbeat pings in the runtime itself, without waking the
    // hibernated DO. Clients use this to detect silently dead connections.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Load persisted state before handling any request.
    ctx.blockConcurrencyWhile(async () => {
      this.game = (await ctx.storage.get('game')) || null;
      this.secrets = (await ctx.storage.get('secrets')) || {};
    });
  }

  // Persist game + secrets atomically, and refresh the inactivity alarm.
  async persist() {
    await this.ctx.storage.put({ game: this.game, secrets: this.secrets });
    await this.ctx.storage.setAlarm(Date.now() + this.expiryMs);
  }

  // ---- RPC: called by the Worker when a host creates a game ----
  // Returns { ok:false } if this code is already taken so the Worker can retry.
  async createGame(hostName, code) {
    if (this.game) return { ok: false };
    this.game = createGame(hostName);
    this.game.code = code; // use the Worker-assigned routing code
    const host = this.game.players[0];
    const token = crypto.randomUUID();
    this.secrets = { [host.id]: token };
    await this.persist();
    return { ok: true, code: this.game.code, playerId: host.id, token };
  }

  // ---- WebSocket upgrade ----
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernatable WebSocket: the DO can be evicted between messages and the
    // runtime redelivers via webSocketMessage/webSocketClose.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Hibernation handlers ----
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      await this.handleHello(ws, msg);
      return;
    }

    const att = ws.deserializeAttachment();
    if (!att || !att.playerId) {
      this.send(ws, { type: 'error', message: 'Send hello first' });
      return;
    }

    if (msg.type === 'action') {
      await this.handleAction(ws, att.playerId, msg);
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att || !att.playerId || !this.game) return;

    // Only mark the player disconnected if they have no other live socket.
    const stillConnected = this.ctx.getWebSockets().some((other) => {
      if (other === ws) return false;
      const a = other.deserializeAttachment();
      return a && a.playerId === att.playerId;
    });

    if (!stillConnected) {
      const player = this.game.players.find((p) => p.id === att.playerId);
      if (player) {
        player.connected = false;
        await this.persist();
        this.broadcast();
      }
    }
  }

  async webSocketError() {
    // Errors are followed by a close event; nothing extra to do.
  }

  // ---- Join / reconnect ----
  async handleHello(ws, msg) {
    if (!this.game) {
      this.send(ws, { type: 'error', message: 'Game not found' });
      ws.close(1000, 'Game not found');
      return;
    }

    let playerId = null;
    let token = null;

    const hasValidToken =
      msg.playerId && msg.token && this.secrets[msg.playerId] === msg.token &&
      this.game.players.some((p) => p.id === msg.playerId);

    if (hasValidToken) {
      // Fast path: reconnect by token (same browser), no token rotation.
      playerId = msg.playerId;
      token = msg.token;
      const player = this.game.players.find((p) => p.id === playerId);
      player.connected = true;
      player.lastSeen = Date.now();
    } else if (normalizeName(msg.name)) {
      // Canonicalize before storing or comparing, so "the same name" matches
      // across devices and keyboards (unicode forms, zero-width chars, spacing).
      const name = normalizeName(msg.name);
      const existing = this.game.players.find(
        (p) => normalizeName(p.name).toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        // Reclaim an existing seat with just game code + name — works from ANY
        // device/browser, even mid-game, and even if the saved token was lost.
        // We trust the name here by design: not being locked out of your own
        // game matters more than preventing a co-player from impersonating you.
        // A fresh token is issued so the new device becomes the live one.
        playerId = existing.id;
        token = crypto.randomUUID();
        this.secrets[playerId] = token;
        existing.connected = true;
        existing.lastSeen = Date.now();
      } else {
        // New name → join (GameActions.join enforces lobby-only + full/dup rules).
        try {
          const res = GameActions.join(this.game, msg.name);
          playerId = res.playerId;
          token = crypto.randomUUID();
          this.secrets[playerId] = token;
        } catch (e) {
          this.send(ws, { type: 'error', message: e.message });
          ws.close(1000, 'Join rejected');
          return;
        }
      }
    } else {
      this.send(ws, { type: 'error', message: 'Unknown player' });
      ws.close(1000, 'Unknown player');
      return;
    }

    ws.serializeAttachment({ playerId });
    const player = this.game.players.find((p) => p.id === playerId);
    this.send(ws, {
      type: 'identity',
      playerId,
      token,
      isHost: !!(player && player.isHost)
    });

    await this.persist();
    this.broadcast();
  }

  // ---- Game actions ----
  async handleAction(ws, playerId, msg) {
    const data = msg.data || {};
    let removedId = null;      // set when a player leaves/is kicked
    let removedByHost = false; // true only for a kick (so we notify the removed one)
    try {
      switch (msg.action) {
        case 'start':
          GameActions.start(this.game, playerId);
          break;
        case 'propose':
          GameActions.propose(this.game, playerId, data.team);
          break;
        case 'vote':
          GameActions.vote(this.game, playerId, data.approve);
          break;
        case 'continueFromVote':
          GameActions.continueFromVote(this.game, playerId);
          break;
        case 'questVote':
          GameActions.questVote(this.game, playerId, data.success);
          break;
        case 'continueFromQuest':
          GameActions.continueFromQuest(this.game, playerId);
          break;
        case 'assassinate':
          GameActions.assassinate(this.game, playerId, data.targetId);
          break;
        case 'leave':
          removedId = GameActions.leave(this.game, playerId).removedId;
          break;
        case 'kick':
          removedId = GameActions.kick(this.game, playerId, data.targetId).removedId;
          removedByHost = true;
          break;
        default:
          throw new Error('Unknown action');
      }
    } catch (e) {
      this.send(ws, { type: 'error', message: e.message });
      return;
    }

    await this.persist();

    if (removedId) {
      delete this.secrets[removedId];
      // Notify + disconnect the removed player's sockets before broadcasting the
      // updated roster, so they don't briefly render a game they're no longer in.
      for (const sock of this.ctx.getWebSockets()) {
        const att = sock.deserializeAttachment();
        if (att && att.playerId === removedId) {
          if (removedByHost) {
            this.send(sock, { type: 'removed', message: 'The host removed you from the game.' });
          }
          try { sock.close(1000, 'Removed'); } catch { /* ignore */ }
        }
      }
    }

    this.broadcast();
  }

  // ---- Broadcasting: each socket gets its OWN filtered view ----
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att || !att.playerId) continue;
      this.sendState(ws, att.playerId);
    }
  }

  sendState(ws, playerId) {
    this.send(ws, {
      type: 'state',
      state: getPublicGameState(this.game, playerId),
      knowledge: getPlayerKnowledge(this.game, playerId)
    });
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // Socket may be closing; ignore.
    }
  }

  // ---- Inactivity cleanup (replaces KV TTL) ----
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Game expired');
      } catch {
        /* ignore */
      }
    }
    await this.ctx.storage.deleteAll();
    this.game = null;
    this.secrets = {};
  }
}

// ============================================================
// Worker entry point
// ============================================================

async function handleCreate(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty body */
  }
  const name = normalizeName(body.name);
  if (!name) return jsonResponse({ error: 'Name is required' }, 400);

  // Generate a unique code by asking each candidate DO to claim it.
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = generateGameCode();
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
    const result = await stub.createGame(name, code);
    if (result.ok) {
      return jsonResponse({
        success: true,
        gameCode: result.code,
        playerId: result.playerId,
        token: result.token
      });
    }
  }
  return jsonResponse({ error: 'Could not allocate a game code, try again' }, 503);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Create a new game.
    if (path === '/api/create' && request.method === 'POST') {
      return handleCreate(request, env);
    }

    // WebSocket connection into a game's Durable Object.
    if (path === '/api/ws') {
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!code) return new Response('Missing game code', { status: 400 });
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
      return stub.fetch(request);
    }

    // Everything else is a static asset (index.html, transport, etc.).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};
