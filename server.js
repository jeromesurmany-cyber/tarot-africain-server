/**
 * Tarot Africain — Serveur de jeu réseau local
 * Usage : node server/server.js
 * Les clients se connectent via ws://[IP_HOTE]:3001
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createSocket } from 'dgram';
import os from 'os';

// ─────────────────────────────────────────────
// UTILITAIRES RÉSEAU
// ─────────────────────────────────────────────

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// ─────────────────────────────────────────────
// LOGIQUE DE JEU (portée depuis gameLogic.js)
// ─────────────────────────────────────────────

function createDeck() {
  const deck = [];
  deck.push({ id: 'excuse', value: 0, label: 'E', isExcuse: true });
  for (let i = 1; i <= 21; i++) {
    deck.push({ id: `atout_${i}`, value: i, label: String(i), isExcuse: false });
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardsPerRound(round) {
  return [0, 5, 4, 3, 2, 1, 2, 3, 4, 5][round] || 1;
}

const TOTAL_ROUNDS = 9;

function dealCards(round) {
  const deck = shuffleDeck(createDeck());
  const hands = [[], [], [], []];
  const count = cardsPerRound(round);
  for (let i = 0; i < count * 4; i++) hands[i % 4].push(deck[i]);
  return hands;
}

function getWinningCardIndex(trick, excuseEffectiveValues = {}) {
  let bestIdx = -1, bestValue = -1;
  for (let i = 0; i < trick.length; i++) {
    const { card, playerIndex } = trick[i];
    const val = card.isExcuse ? (excuseEffectiveValues[playerIndex] ?? 0) : card.value;
    if (val > bestValue) { bestValue = val; bestIdx = i; }
  }
  return bestIdx;
}

function isLastBidValid(bids, newBid, round) {
  return bids.reduce((s, b) => s + b, 0) + newBid !== cardsPerRound(round);
}

function calculatePoints(bid, tricksWon, mode) {
  if (mode === 'lives') {
    return bid === tricksWon ? 0 : -(Math.abs(bid - tricksWon));
  }
  return bid === tricksWon ? 10 + tricksWon * 2 : -(Math.abs(bid - tricksWon) * 2);
}

function aiChooseBid(hand, existingBids, round, isLastBidder) {
  const strongCards = hand.filter(c => !c.isExcuse && c.value >= 14);
  let bid = Math.min(strongCards.length, cardsPerRound(round));
  if (isLastBidder) {
    const sum = existingBids.reduce((s, b) => s + b, 0);
    if (sum + bid === cardsPerRound(round)) {
      bid = bid + 1 <= cardsPerRound(round) ? bid + 1 : Math.max(0, bid - 1);
    }
  }
  return Math.max(0, bid);
}

function aiChooseCard(hand, trickSoFar, bid, tricksWon) {
  const nonExcuse = hand.filter(c => !c.isExcuse);
  const excuseCard = hand.find(c => c.isExcuse);
  const needMore = tricksWon < bid;
  const best = trickSoFar.length > 0
    ? Math.max(...trickSoFar.map(t => t.card.isExcuse ? -1 : t.card.value)) : -1;

  if (nonExcuse.length === 0) return { card: excuseCard, excuseChoice: needMore ? 'high' : 'low' };

  const sorted = [...nonExcuse].sort((a, b) => a.value - b.value);
  if (!needMore) {
    const under = sorted.filter(c => c.value < best);
    if (under.length) return { card: under[under.length - 1], excuseChoice: null };
    if (excuseCard) return { card: excuseCard, excuseChoice: 'low' };
    return { card: sorted[0], excuseChoice: null };
  } else {
    const winning = sorted.filter(c => c.value > best);
    if (winning.length) return { card: winning[0], excuseChoice: null };
    if (excuseCard) return { card: excuseCard, excuseChoice: 'high' };
    return { card: sorted[0], excuseChoice: null };
  }
}

// ─────────────────────────────────────────────
// ÉTAT DU SERVEUR
// ─────────────────────────────────────────────

// rooms : Map<roomCode, RoomState>
const rooms = new Map();

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/**
 * Structure d'une room :
 * {
 *   code, hostId, gameMode, startingLives,
 *   players: [{ id, name, ws, seatIndex, isAI }],  // 4 slots max
 *   phase, round, dealerIndex,
 *   hands, bids, tricksWon, scores, roundHistory,
 *   currentTrick, currentPlayerIndex, excuseEffectiveValues,
 *   trickWinner, lastRoundPoints,
 * }
 */

function createRoom(hostWs, hostName, gameMode, startingLives) {
  const code = makeRoomCode();
  const hostId = hostWs.id;
  const initialScores = gameMode === 'lives'
    ? [startingLives, startingLives, startingLives, startingLives]
    : [0, 0, 0, 0];

  const room = {
    code, hostId, gameMode,
    startingLives: Number(startingLives) || 10,
    players: [
      { id: hostId, name: hostName, ws: hostWs, seatIndex: 0, isAI: false },
      { id: 'ai1', name: 'Merlin',  ws: null, seatIndex: 1, isAI: true },
      { id: 'ai2', name: 'Oracle',  ws: null, seatIndex: 2, isAI: true },
      { id: 'ai3', name: 'Sphinx',  ws: null, seatIndex: 3, isAI: true },
    ],
    phase: 'lobby',
    round: 0, dealerIndex: 0,
    hands: [[], [], [], []],
    bids: [null, null, null, null],
    tricksWon: [0, 0, 0, 0],
    scores: initialScores,
    roundHistory: [],
    currentTrick: [],
    currentPlayerIndex: 0,
    excuseEffectiveValues: {},
    trickWinner: null,
    lastRoundPoints: null,
    aiTimers: [],
  };
  rooms.set(code, room);
  return room;
}

// ─────────────────────────────────────────────
// BROADCAST HELPERS
// ─────────────────────────────────────────────

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}) {
  room.players.forEach(p => {
    if (!p.isAI) send(p.ws, type, payload);
  });
}

/** Envoie le state complet à tous, mais masque les mains des autres joueurs */
function broadcastState(room, message = '') {
  room.players.forEach(p => {
    if (p.isAI || !p.ws) return;
    const si = p.seatIndex;
    const isOneCardRound = cardsPerRound(room.round) === 1;
    const hideOwnHand = isOneCardRound &&
      (room.phase === 'dealing' || room.phase === 'preview_opponents' || room.phase === 'bidding');

    // Construction des mains visibles depuis ce joueur
    const visibleHands = room.hands.map((hand, idx) => {
      if (idx === si) {
        // Sa propre main : cachée si manche 1 carte avant le jeu
        return hideOwnHand ? hand.map(() => null) : hand;
      }
      // Main adversaire : révélée pendant preview_opponents, cachée sinon
      if (room.phase === 'preview_opponents') {
        return hand; // cartes visibles pour que le joueur puisse enchérir
      }
      return hand.map(() => null); // dos visible
    });

    send(p.ws, 'STATE', {
      state: {
        phase: room.phase,
        round: room.round,
        dealerIndex: room.dealerIndex,
        hands: visibleHands,
        rawHandCount: room.hands.map(h => h.length),
        bids: room.bids,
        tricksWon: room.tricksWon,
        scores: room.scores,
        roundHistory: room.roundHistory,
        currentTrick: room.currentTrick,
        currentPlayerIndex: room.currentPlayerIndex,
        trickWinner: room.trickWinner,
        excuseEffectiveValues: room.excuseEffectiveValues,
        lastRoundPoints: room.lastRoundPoints,
        // IDs des joueurs ayant confirmé la preview (pour afficher "en attente de X")
        previewConfirmedIds: room._previewReady ? [...room._previewReady] : [],
        iConfirmedPreview: room._previewReady ? room._previewReady.has(p.id) : false,
        players: room.players.map(pl => ({
          id: pl.id, name: pl.name,
          seatIndex: pl.seatIndex, isAI: pl.isAI,
        })),
        mySeatIndex: si,
        gameMode: room.gameMode,
        startingLives: room.startingLives,
        message,
      }
    });
  });
}

// ─────────────────────────────────────────────
// LOGIQUE DE JEU — FLUX
// ─────────────────────────────────────────────

function getBidOrder(dealer) {
  const first = (dealer + 1) % 4;
  return [0, 1, 2, 3].map(i => (first + i) % 4);
}

function startRound(room) {
  const r = room.round;
  room.hands = dealCards(r);
  room.bids = [null, null, null, null];
  room.tricksWon = [0, 0, 0, 0];
  room.currentTrick = [];
  room.trickWinner = null;
  room.excuseEffectiveValues = {};
  room.lastRoundPoints = null;
  room.phase = 'dealing';

  broadcastState(room, `Distribution — Manche ${r}...`);

  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (cardsPerRound(r) === 1) {
      room.phase = 'preview_opponents';
      broadcastState(room, `Manche ${r} — Observez les cartes adverses, puis enchérissez.`);
    } else {
      room.phase = 'preview';
      broadcastState(room, `Manche ${r} — Observez vos cartes, puis cliquez Enchérir.`);
    }
  }, 1200);
}

function startBidding(room) {
  const order = getBidOrder(room.dealerIndex);
  const first = order[0];
  room.currentPlayerIndex = first;
  room.phase = 'bidding';
  broadcastState(room, `Enchères — ${room.players[first].name} commence.`);
  if (room.players[first].isAI) scheduleAiBid(room, order);
}

function scheduleAiBid(room, order) {
  const timer = setTimeout(() => {
    if (!rooms.has(room.code) || room.phase !== 'bidding') return;
    const idx = room.currentPlayerIndex;
    if (!room.players[idx].isAI) return;

    const existing = room.bids.filter(b => b !== null);
    const remaining = order.filter(i => room.bids[i] === null);
    const isLast = remaining.length === 1;
    const bid = aiChooseBid(room.hands[idx], existing, room.round, isLast);
    room.bids[idx] = bid;
    broadcastState(room, `${room.players[idx].name} annonce ${bid}.`);

    const nextRemaining = order.filter(i => room.bids[i] === null);
    if (nextRemaining.length === 0) {
      beginPlay(room);
    } else {
      room.currentPlayerIndex = nextRemaining[0];
      if (room.players[nextRemaining[0]].isAI) scheduleAiBid(room, order);
      else broadcastState(room, `À vous d'enchérir.`);
    }
  }, 900);
  room.aiTimers.push(timer);
}

function beginPlay(room) {
  const first = (room.dealerIndex + 1) % 4;
  room.currentPlayerIndex = first;
  room.phase = 'playing';
  const total = room.bids.reduce((s, b) => s + (b || 0), 0);
  const msg = `Enchères terminées. Total : ${total}/${cardsPerRound(room.round)}. ${room.players[first].name} ouvre.`;
  broadcastState(room, msg);
  if (room.players[first].isAI) scheduleAiPlay(room);
}

function scheduleAiPlay(room) {
  const timer = setTimeout(() => {
    if (!rooms.has(room.code) || room.phase !== 'playing') return;
    const idx = room.currentPlayerIndex;
    if (!room.players[idx].isAI) return;
    const hand = room.hands[idx];
    if (!hand || hand.length === 0) return;
    const { card, excuseChoice } = aiChooseCard(
      hand, room.currentTrick,
      room.bids[idx] || 0, room.tricksWon[idx]
    );
    broadcastState(room, `${room.players[idx].name} joue...`);
    executePlayCard(room, idx, card, excuseChoice);
  }, 1100);
  room.aiTimers.push(timer);
}

function executePlayCard(room, playerIdx, card, excuseChoice) {
  // Retire la carte de la main
  room.hands[playerIdx] = room.hands[playerIdx].filter(c => c.id !== card.id);

  // Valeur effective Excuse
  if (card.isExcuse && excuseChoice) {
    room.excuseEffectiveValues[playerIdx] = excuseChoice === 'high' ? 22 : 0;
  }

  room.currentTrick.push({ card, playerIndex: playerIdx });
  broadcastState(room);

  if (room.currentTrick.length === 4) {
    setTimeout(() => resolveTrick(room), 800);
  } else {
    const next = (playerIdx + 1) % 4;
    room.currentPlayerIndex = next;
    if (room.players[next].isAI) {
      scheduleAiPlay(room);
    } else {
      broadcastState(room, 'À votre tour de jouer.');
    }
  }
}

function resolveTrick(room) {
  const winIdx = getWinningCardIndex(room.currentTrick, room.excuseEffectiveValues);
  const winnerId = room.currentTrick[winIdx].playerIndex;
  room.tricksWon[winnerId]++;
  room.trickWinner = winnerId;
  room.excuseEffectiveValues = {};
  broadcastState(room, `${room.players[winnerId].name} remporte ce pli !`);

  const played = room.tricksWon.reduce((s, t) => s + t, 0);
  const max = cardsPerRound(room.round);

  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    room.currentTrick = [];
    room.trickWinner = null;

    if (played >= max) {
      endRound(room);
    } else {
      room.currentPlayerIndex = winnerId;
      broadcastState(room, room.players[winnerId].isAI
        ? `${room.players[winnerId].name} mène le prochain pli.`
        : 'Vous menez le prochain pli.');
      if (room.players[winnerId].isAI) scheduleAiPlay(room);
    }
  }, 1200);
}

function endRound(room) {
  const points = room.bids.map((bid, i) =>
    calculatePoints(bid, room.tricksWon[i], room.gameMode)
  );
  room.scores = room.scores.map((s, i) => s + points[i]);
  room.lastRoundPoints = points;
  room.roundHistory.push({
    round: room.round,
    bids: [...room.bids],
    tricks: [...room.tricksWon],
    points,
    scores: [...room.scores],
  });

  const eliminated = room.gameMode === 'lives' && room.scores.some(s => s <= 0);
  const roundsFinished = room.gameMode !== 'lives' && room.round >= TOTAL_ROUNDS;
  if (eliminated || roundsFinished) {
    room.phase = 'game_end';
  } else {
    room.phase = 'round_end';
  }
  broadcastState(room, `Fin de la manche ${room.round} !`);
}

function nextRound(room) {
  room.round++;
  // En mode vies : cycle infini 1→9→1→9…
  if (room.round > TOTAL_ROUNDS) room.round = 1;
  room.dealerIndex = (room.dealerIndex + 1) % 4;
  startRound(room);
}

function clearTimers(room) {
  room.aiTimers.forEach(t => clearTimeout(t));
  room.aiTimers = [];
}

// ─────────────────────────────────────────────
// SERVEUR HTTP (IP + CORS pour le client)
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const UDP_PORT = 3002;

const httpServer = createServer((req, res) => {
  // CORS pour que le client Vite puisse fetch
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/info') {
    // Retourne les IPs locales et les parties en lobby
    const lobbyRooms = [];
    for (const [code, room] of rooms) {
      if (room.phase === 'lobby') {
        lobbyRooms.push({
          code,
          players: room.players.filter(p => !p.isAI).length,
          gameMode: room.gameMode,
          startingLives: room.startingLives,
        });
      }
    }
    res.end(JSON.stringify({ ips: getLocalIPs(), rooms: lobbyRooms }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

const wss = new WebSocketServer({ server: httpServer });

let clientIdCounter = 0;

wss.on('connection', (ws) => {
  ws.id = `client_${++clientIdCounter}`;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));

  // Envoyer l'IP locale pour que l'hôte puisse la communiquer
  send(ws, 'CONNECTED', { clientId: ws.id });
});

function handleMessage(ws, msg) {
  const { type } = msg;

  switch (type) {
    // ── LOBBY ──────────────────────────────────
    case 'CREATE_ROOM': {
      const { name, gameMode, startingLives } = msg;
      const room = createRoom(ws, name || 'Hôte', gameMode || 'lives', startingLives || 10);
      ws.roomCode = room.code;
      send(ws, 'ROOM_CREATED', { code: room.code });
      broadcastLobby(room);
      break;
    }

    case 'JOIN_ROOM': {
      const { code, name } = msg;
      const room = rooms.get(code?.toUpperCase());
      if (!room) { send(ws, 'ERROR', { message: 'Salon introuvable.' }); return; }
      if (room.phase !== 'lobby') { send(ws, 'ERROR', { message: 'La partie a déjà commencé.' }); return; }

      // Cherche un slot IA libre et le remplace par ce joueur
      const aiSlot = room.players.find(p => p.isAI);
      if (!aiSlot) { send(ws, 'ERROR', { message: 'La partie est complète.' }); return; }

      aiSlot.id = ws.id;
      aiSlot.name = name || 'Joueur';
      aiSlot.ws = ws;
      aiSlot.isAI = false;
      ws.roomCode = room.code;
      broadcastLobby(room);
      break;
    }

    case 'KICK_SLOT': {
      // L'hôte peut renvoyer un joueur humain et le remplacer par IA
      const room = getRoomOf(ws);
      if (!room || ws.id !== room.hostId) return;
      const { seatIndex } = msg;
      const slot = room.players[seatIndex];
      if (!slot || slot.isAI || slot.id === room.hostId) return;
      send(slot.ws, 'KICKED', {});
      slot.isAI = true;
      slot.id = `ai${seatIndex}`;
      slot.name = ['Merlin','Oracle','Sphinx'][seatIndex - 1] || 'IA';
      slot.ws = null;
      broadcastLobby(room);
      break;
    }

    case 'RENAME_AI': {
      const room = getRoomOf(ws);
      if (!room || ws.id !== room.hostId) return;
      const { seatIndex, name } = msg;
      if (room.players[seatIndex]?.isAI) room.players[seatIndex].name = name;
      broadcastLobby(room);
      break;
    }

    case 'START_GAME': {
      const room = getRoomOf(ws);
      if (!room || ws.id !== room.hostId || room.phase !== 'lobby') return;
      const initialScores = room.gameMode === 'lives'
        ? Array(4).fill(room.startingLives) : Array(4).fill(0);
      room.scores = initialScores;
      room.round = 1;
      room.dealerIndex = 0;
      room.roundHistory = [];
      startRound(room);
      break;
    }

    // ── PREVIEW ──────────────────────────────────
    case 'CONFIRM_PREVIEW': {
      const room = getRoomOf(ws);
      if (!room) return;
      const player = room.players.find(p => p.id === ws.id);
      if (!player) return;

      if (!room._previewReady) room._previewReady = new Set();
      room._previewReady.add(ws.id);

      const humanPlayers = room.players.filter(p => !p.isAI);
      const readyCount = room._previewReady.size;
      const totalCount = humanPlayers.length;

      if (readyCount >= totalCount) {
        room._previewReady = null;
        startBidding(room);
      } else {
        // Broadcaster qui a confirmé et combien restent
        const waitingFor = humanPlayers
          .filter(p => !room._previewReady.has(p.id))
          .map(p => p.name);
        broadcastState(room, `${player.name} est prêt. En attente de : ${waitingFor.join(', ')}…`);
        // Marquer dans le state que ce joueur a confirmé
        room._previewConfirmed = room._previewReady;
      }
      break;
    }

    // ── ENCHÈRES ──────────────────────────────────
    case 'BID': {
      const room = getRoomOf(ws);
      if (!room || room.phase !== 'bidding') return;
      const player = room.players.find(p => p.id === ws.id);
      if (!player || room.currentPlayerIndex !== player.seatIndex) return;

      const { bid } = msg;
      const order = getBidOrder(room.dealerIndex);
      const existing = room.bids.filter(b => b !== null);
      const isLast = order[order.length - 1] === player.seatIndex;

      if (isLast && !isLastBidValid(existing, bid, room.round)) {
        send(ws, 'ERROR', { message: `Ce pari est interdit (somme = ${cardsPerRound(room.round)}).` });
        return;
      }

      room.bids[player.seatIndex] = bid;
      broadcastState(room, `${player.name} annonce ${bid}.`);

      const remaining = order.filter(i => room.bids[i] === null);
      if (remaining.length === 0) {
        beginPlay(room);
      } else {
        room.currentPlayerIndex = remaining[0];
        if (room.players[remaining[0]].isAI) scheduleAiBid(room, order);
        else broadcastState(room, `À vous d'enchérir.`);
      }
      break;
    }

    // ── JEU ──────────────────────────────────
    case 'PLAY_CARD': {
      const room = getRoomOf(ws);
      if (!room || room.phase !== 'playing') return;
      const player = room.players.find(p => p.id === ws.id);
      if (!player || room.currentPlayerIndex !== player.seatIndex) return;

      const { cardId, excuseChoice } = msg;
      const hand = room.hands[player.seatIndex];
      const card = hand.find(c => c.id === cardId);
      if (!card) { send(ws, 'ERROR', { message: 'Carte introuvable.' }); return; }

      // L'Excuse nécessite un choix
      if (card.isExcuse && !excuseChoice) {
        send(ws, 'NEED_EXCUSE_CHOICE', { cardId });
        return;
      }

      executePlayCard(room, player.seatIndex, card, excuseChoice || null);
      break;
    }

    // ── FIN DE MANCHE ──────────────────────────────────
    case 'NEXT_ROUND': {
      const room = getRoomOf(ws);
      if (!room || ws.id !== room.hostId) return;
      if (room.phase === 'game_end') {
        // Nouvelle partie
        const initialScores = room.gameMode === 'lives'
          ? Array(4).fill(room.startingLives) : Array(4).fill(0);
        room.scores = initialScores;
        room.round = 0;
        room.roundHistory = [];
        room.dealerIndex = 0;
        room.phase = 'lobby';
        broadcastLobby(room);
      } else if (room.phase === 'round_end') {
        clearTimers(room);
        nextRound(room);
      }
      break;
    }

    case 'LEAVE_ROOM': {
      handleDisconnect(ws);
      break;
    }
  }
}

function handleDisconnect(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  const slot = room.players.find(p => p.id === ws.id);
  if (!slot) return;

  if (ws.id === room.hostId && room.phase !== 'lobby') {
    // L'hôte quitte en cours de partie → fin de partie
    broadcast(room, 'HOST_LEFT', { message: "L'hôte a quitté la partie." });
    clearTimers(room);
    rooms.delete(code);
    return;
  }

  // Remplacer ce joueur par une IA
  slot.isAI = true;
  slot.id = `ai_dc_${slot.seatIndex}`;
  slot.ws = null;
  slot.name = slot.name + ' (IA)';
  ws.roomCode = null;

  if (room.phase === 'lobby') {
    broadcastLobby(room);
  } else {
    broadcastState(room, `${slot.name} a quitté. Une IA prend sa place.`);
    // Si c'était son tour, l'IA joue
    if (room.phase === 'playing' && room.currentPlayerIndex === slot.seatIndex) {
      scheduleAiPlay(room);
    } else if (room.phase === 'bidding' && room.currentPlayerIndex === slot.seatIndex) {
      scheduleAiBid(room, getBidOrder(room.dealerIndex));
    }
  }
}

function getRoomOf(ws) {
  return ws.roomCode ? rooms.get(ws.roomCode) : null;
}

function broadcastLobby(room) {
  broadcast(room, 'LOBBY', {
    code: room.code,
    gameMode: room.gameMode,
    startingLives: room.startingLives,
    players: room.players.map(p => ({
      id: p.id, name: p.name,
      seatIndex: p.seatIndex, isAI: p.isAI,
    })),
  });
}

// ─────────────────────────────────────────────
// UDP DISCOVERY — répond aux broadcasts des clients
// ─────────────────────────────────────────────

function startUdpDiscovery() {
  const udp = createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'TAROT_DISCOVER') {
        const reply = Buffer.from(JSON.stringify({
          type: 'TAROT_SERVER',
          port: PORT,
          ips: getLocalIPs(),
        }));
        udp.send(reply, rinfo.port, rinfo.address);
      }
    } catch {}
  });
  udp.bind(UDP_PORT, '0.0.0.0', () => {
    udp.setBroadcast(true);
    console.log(`📡 Découverte UDP active sur le port ${UDP_PORT}`);
  });
  udp.on('error', () => {
    console.log('⚠ UDP non disponible (découverte désactivée)');
  });
}

// ─────────────────────────────────────────────
// DÉMARRAGE
// ─────────────────────────────────────────────

httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🃏 Tarot Africain — Serveur LAN    ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  WebSocket + HTTP : port ${PORT}          ║`);
  console.log(`║  Découverte UDP   : port ${UDP_PORT}          ║`);
  console.log('║  IP réseau local :                   ║');
  ips.forEach(ip => console.log(`║    → ${ip.padEnd(30)} ║`));
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Partagez une IP aux autres joueurs  ║');
  console.log('║  Ils ouvrent http://[IP]:5173        ║');
  console.log('╚══════════════════════════════════════╝\n');

  startUdpDiscovery();
});
