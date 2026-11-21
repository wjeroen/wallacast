#!/usr/bin/env node
// A stand-in for the Wallacast server's remote control (backend/src/services/remote-control.ts),
// to try the watch app on an emulator without a real token or a real player.
// It plays a short list of made-up items, reports the position every 5 seconds like the real
// page, and carries out the watch's commands about half a second later.
//
// Usage:  node android/tools/fake-remote.mjs [port]          (default port 8790)
//         adb reverse tcp:8790 tcp:8790
//         adb shell am start -n io.github.wjeroen.wallacast.watch/.MainActivity \
//           --es server http://localhost:8790 --es token wcr_fake
// The watch allows plain http only to localhost (res/xml/network_security_config.xml).
import http from 'node:http';

const port = Number(process.argv[2] || 8790);
const REPORT_MS = 5_000;
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

const items = [
  { item_id: 3369, title: '[AI Narration] Can the US Afford to Pace the Frontier?', subtitle: 'ForeCast', duration: 1833 },
  { item_id: 3370, title: 'Short title', subtitle: 'Astral Codex Ten', duration: 111 },
  { item_id: 3371, title: 'Why the next decade of AI policy will be decided by a handful of very long committee meetings', subtitle: 'Some Author With A Rather Long Name, Another Co-Author', duration: 7322 },
  { item_id: 3372, title: 'A title without an author', subtitle: null, duration: 640 },
];

let index = 0;
const player = { playing: true, position: 94, speed: 1.25, shuffle: false, archived: new Set(), starred: new Set() };
let playingSince = Date.now();
let stateAt = Date.now();
let snapshot = null;

function livePosition() {
  const pos = player.position + (player.playing ? ((Date.now() - playingSince) / 1000) * player.speed : 0);
  return Math.min(items[index].duration, pos);
}

/** What the page would report right now */
function report() {
  const item = items[index];
  snapshot = {
    ...item,
    type: 'podcast_episode',
    playing: player.playing,
    position: Math.floor(livePosition()),
    speed: player.speed,
    speeds: SPEEDS,
    shuffle: player.shuffle,
    is_archived: player.archived.has(item.item_id),
    is_starred: player.starred.has(item.item_id),
    has_next: true,
    has_previous: true,
    hidden: false,
    loaded: true,
    last_command: null,
  };
  stateAt = Date.now();
}

function settle() {
  player.position = livePosition();
  playingSince = Date.now();
}

function go(to) {
  index = (to + items.length) % items.length;
  player.position = 0;
  playingSince = Date.now();
}

function run(command) {
  const id = items[index].item_id;
  settle();
  switch (command.action) {
    case 'play': player.playing = true; break;
    case 'pause': player.playing = false; break;
    case 'toggle': player.playing = !player.playing; break;
    case 'next': go(index + 1); break;
    case 'previous': go(index - 1); break;
    case 'forward': player.position = Math.min(items[index].duration, player.position + 15); break;
    case 'back': player.position = Math.max(0, player.position - 15); break;
    case 'shuffle': player.shuffle = typeof command.value === 'boolean' ? command.value : !player.shuffle; break;
    case 'speed': player.speed = command.value; break;
    case 'archive': player.archived.add(id); break;
    case 'unarchive': player.archived.delete(id); break;
    case 'star': player.starred.add(id); break;
    case 'unstar': player.starred.delete(id); break;
  }
  report();
}

report();
setInterval(() => { if (player.playing) report(); }, REPORT_MS);

let nextId = 1;
const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url.startsWith('/api/remote/state')) {
    return send(200, { online: true, mode: 'app', age_seconds: Math.round((Date.now() - stateAt) / 1000), state: snapshot });
  }
  if (req.method === 'POST' && req.url.startsWith('/api/remote/command')) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let command;
      try { command = JSON.parse(raw); } catch { return send(400, { error: 'bad JSON' }); }
      const id = nextId++;
      console.log(`command ${id} ${command.action}${command.value !== undefined ? `=${command.value}` : ''}`);
      setTimeout(() => run(command), 500);
      send(202, { id, action: command.action });
    });
    return;
  }
  send(404, { error: 'not here' });
});
server.listen(port, () => console.log(`fake remote on http://localhost:${port}`));
