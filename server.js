// Free-tier friendly relay: matches two players by room code and runs the match.
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MATCH_TIME = 10; // seconds of clicking
const COUNTDOWN = 3;   // seconds between "ready" and the start

// Plain HTTP answer so the host (and you, in a browser) can check it's alive.
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});
const wss = new WebSocketServer({ server, maxPayload: 1024 });

const rooms = new Map(); // code -> room

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function cleanCode(c) {
  return String(c || "").trim().toUpperCase().slice(0, 12);
}
function endRoom(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
  rooms.delete(room.code);
  for (const p of [room.host, room.guest]) if (p) p.room = null;
}
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  const other = room.host === ws ? room.guest : room.host;
  endRoom(room);
  send(other, { t: "opponent_left" });
}

function startMatch(room) {
  room.timers.push(setTimeout(() => {
    room.running = true;
    room.scores = { host: 0, guest: 0 };
    send(room.host, { t: "start", duration: MATCH_TIME });
    send(room.guest, { t: "start", duration: MATCH_TIME });

    room.timers.push(setTimeout(() => {
      room.running = false;
      const h = room.scores.host, g = room.scores.guest;
      send(room.host, { t: "end", won: h > g, draw: h === g });
      send(room.guest, { t: "end", won: g > h, draw: h === g });
      endRoom(room);
    }, MATCH_TIME * 1000));
  }, COUNTDOWN * 1000));
}

wss.on("connection", (ws) => {
  ws.room = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.t === "host") {
      const code = cleanCode(msg.code);
      if (!code) return send(ws, { t: "error", msg: "Enter a code first" });
      leave(ws);
      if (rooms.has(code)) return send(ws, { t: "error", msg: "That room already exists" });
      const room = { code, host: ws, guest: null, running: false,
                     scores: { host: 0, guest: 0 }, timers: [] };
      rooms.set(code, room);
      ws.room = room;
      send(ws, { t: "hosted", code });

    } else if (msg.t === "join") {
      const code = cleanCode(msg.code);
      leave(ws);
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", msg: "Room doesn't exist" });
      if (room.guest) return send(ws, { t: "error", msg: "Room is full" });
      room.guest = ws;
      ws.room = room;
      send(room.host, { t: "ready", code });
      send(room.guest, { t: "ready", code });
      startMatch(room);

    } else if (msg.t === "click") {
      const room = ws.room;
      if (!room || !room.running) return;
      room.scores[room.host === ws ? "host" : "guest"]++;
      send(room.host,  { t: "score", mine: room.scores.host,  theirs: room.scores.guest });
      send(room.guest, { t: "score", mine: room.scores.guest, theirs: room.scores.host });
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

// Drop dead connections and keep idle ones from being closed by proxies.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, () => console.log("Relay listening on port " + PORT));
