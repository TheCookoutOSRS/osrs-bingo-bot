// Boot logs
console.log("[BOOT] starting Cookout Bingo Bot...");

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fs from "fs";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import { createCanvas } from "@napi-rs/canvas"; // render-friendly canvas

const app = express();
app.use(bodyParser.json());

// --- Env ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PASSWORD = process.env.PASSWORD || "Fall Cookout 25";
const START_TIME = new Date(process.env.START_TIME || "2025-09-05T07:00:00Z");
const BINGO_WEBHOOK_SECRET = process.env.BINGO_WEBHOOK_SECRET || "";

console.log(
  "[ENV]",
  "client:", CLIENT_ID ? "OK" : "MISSING",
  "| guild:", GUILD_ID ? "OK" : "MISSING",
  "| token:", DISCORD_TOKEN ? "OK" : "MISSING"
);

// --- Data layer ---
const DEFAULT_REPO_PATH = "./bingo.json";
const DATA_PATH = process.env.DATA_PATH || DEFAULT_REPO_PATH;

function initDataFile() {
  const onDisk = fs.existsSync(DATA_PATH);
  const inRepo = fs.existsSync(DEFAULT_REPO_PATH);

  if (!onDisk && DATA_PATH !== DEFAULT_REPO_PATH && inRepo) {
    try {
      fs.copyFileSync(DEFAULT_REPO_PATH, DATA_PATH);
      console.log(`[DATA] Seeded ${DATA_PATH} from ${DEFAULT_REPO_PATH}`);
      return;
    } catch (e) {
      console.warn("[DATA] Failed to seed from repo:", e);
    }
  }

  if (!onDisk && !inRepo) {
    const empty = {
      rsnToTeam: {},
      tiles: [],
      completedByTeam: {},
      channelId: ""
    };
    fs.writeFileSync(DATA_PATH, JSON.stringify(empty, null, 2));
    console.log(`[DATA] Created new data file at ${DATA_PATH}`);
  }
}

function loadData() {
  initDataFile();
  const d = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  if (d.completed && !d.completedByTeam) {
    console.warn("[MIGRATE] Found legacy 'completed'. Creating completedByTeam.GLOBAL.");
    d.completedByTeam = { GLOBAL: d.completed };
    delete d.completed;
    fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
  }
  if (!d.completedByTeam) d.completedByTeam = {};

  // debug: log where we loaded from and when it was last modified
  try {
    const stat = fs.statSync(DATA_PATH);
    console.log(`[DATA] Loaded ${DATA_PATH} (mtime ${new Date(stat.mtimeMs).toISOString()})`);
  } catch {}
  return d;
}

function saveData(d) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
  try {
    const stat = fs.statSync(DATA_PATH);
    console.log(`[DATA] Saved ${DATA_PATH} (mtime ${new Date(stat.mtimeMs).toISOString()})`);
  } catch {}
}

let data = loadData();



// ------- Helpers -------
function normalizeTeamName(s = "") {
  // Normalize curly apostrophes and trim whitespace
  return String(s).replace(/[’]/g, "'").trim();
}

function findTeamByRSN(rsn) {
  const team = data.rsnToTeam?.[rsn];
  return team ? normalizeTeamName(team) : "Unassigned";
}

function ensureTeamBucket(team) {
  const t = normalizeTeamName(team);
  if (!data.completedByTeam[t]) {
    data.completedByTeam[t] = {};
    try { saveData(data); } catch {}
  }
  return data.completedByTeam[t];
}

function ensureTileProgressForTeam(tile, team) {
  const bucket = ensureTeamBucket(team);
  if (!bucket[tile.key]) {
    bucket[tile.key] = { done: false, by: null, progress: { total: 0 }, sets: {} };
  }
  return bucket[tile.key];
}

function getTileStateForTeam(tile, team) {
  const t = normalizeTeamName(team);
  const bucket = data.completedByTeam?.[t] || {};
  const c = bucket[tile.key];
  return c && c.done ? "done" : "pending";
}

// ------- Autocomplete helpers -------
function allTeamNames() {
  const a = new Set(Object.keys(data.completedByTeam || {}));
  Object.values(data.rsnToTeam || {}).forEach(v => a.add(normalizeTeamName(v)));
  return Array.from(a).filter(Boolean).sort();
}
function allRSNs() {
  return Object.keys(data.rsnToTeam || {}).sort();
}
function allTileKeys() {
  return (data.tiles || []).map(t => t.key).filter(Boolean).sort();
}
function rxToLabel(s = "") {
  return String(s)
    .replace(/\\s\+/g, " ")
    .replace(/[\\^$.*+?()[\]{}|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function allItemSuggestions() {
  const out = new Set();
  for (const t of (data.tiles || [])) {
    if (Array.isArray(t.matches)) t.matches.forEach(rx => out.add(rxToLabel(rx)));
    if (Array.isArray(t.sources)) t.sources.forEach(rx => out.add(rxToLabel(rx)));
    if (Array.isArray(t.set))     t.set.forEach(rx => out.add(rxToLabel(rx)));
    if (Array.isArray(t.sets)) {
      t.sets.forEach(setArr => (setArr || []).forEach(rx => out.add(rxToLabel(rx))));
    }
    if (Array.isArray(t.alternativeMatches)) t.alternativeMatches.forEach(rx => out.add(rxToLabel(rx)));
  }
  return Array.from(out).filter(s => s && s.length >= 3).sort();
}

// ------- Tile matching / progress -------
function matchTile(tile, itemName) {
  if (!tile || !itemName) return false;

  if (tile.type === "single") {
    return tile.matches?.some(rx => new RegExp(rx, "i").test(itemName));
  }
  if (tile.type === "anyCount") {
    return tile.sources?.some(rx => new RegExp(rx, "i").test(itemName));
  }
  if (tile.type === "setAll") {
    return tile.set?.some(rx => new RegExp(rx, "i").test(itemName));
  }
  if (tile.type === "orSetAll") {
    return tile.sets?.flat()?.some(rx => new RegExp(rx, "i").test(itemName));
  }
  if (tile.type === "orCount") {
    const inCountGroup = tile.sources?.some(rx => new RegExp(rx, "i").test(itemName));
    const inAlt = (tile.alternativeMatches || [])?.some(rx => new RegExp(rx, "i").test(itemName));
    return !!(inCountGroup || inAlt);
  }
  if (tile.type === "pet") return false; // manual
  return false;
}

function handleProgressForTeam(tile, team, rsn, itemName) {
  const entry = ensureTileProgressForTeam(tile, team);
  if (entry.done) return false;

  if (tile.type === "single") {
    entry.done = true;
    entry.by = { team: normalizeTeamName(team), rsn, itemName, ts: Date.now() };
    return true;
  }

  if (tile.type === "anyCount") {
    entry.progress.total = (entry.progress.total || 0) + 1;
    if (entry.progress.total >= tile.count) {
      entry.done = true;
      entry.by = { team: normalizeTeamName(team), rsn, itemName, ts: Date.now() };
      return true;
    }
    return false;
  }

  if (tile.type === "setAll") {
    entry.sets.collected = entry.sets.collected || {};
    const matched = tile.set?.find(rx => new RegExp(rx, "i").test(itemName));
    if (matched) entry.sets.collected[matched] = true;

    const allDone = (tile.set || []).every(rx => entry.sets.collected[rx]);
    if (allDone) {
      entry.done = true;
      entry.by = { team: normalizeTeamName(team), rsn, itemName, ts: Date.now() };
      return true;
    }
    return false;
  }

  if (tile.type === "orCount") {
    const inCountGroup = tile.sources?.some(rx => new RegExp(rx, "i").test(itemName));
    const inAlt = (tile.alternativeMatches || [])?.some(rx => new RegExp(rx, "i").test(itemName));

    if (inAlt) {
      entry.done = true;
      entry.by = { team: normalizeTeamName(team), rsn, itemName, ts: Date.now(), alt: true };
      return true;
    }

    if (inCountGroup) {
      entry.progress.total = (entry.progress.total || 0) + 1;
      if (entry.progress.total >= tile.count) {
        entry.done = true;
        entry.by = { team: normalizeTeamName(team), rsn, itemName, ts: Date.now() };
        return true;
      }
      return false;
    }
  }

  if (tile.type === "orSetAll") {
    entry.sets = entry.sets || {};
    const sets = tile.sets || [];
    for (let idx = 0; idx < sets.length; idx++) {
      const setArr = sets[idx] || [];
      const matchInThisSet = setArr.find(rx => new RegExp(rx, "i").test(itemName));
      if (matchInThisSet) {
        entry.sets[idx] = entry.sets[idx] || {};
        entry.sets[idx][matchInThisSet] = true;
      }
      const allThisDone = setArr.length > 0 && setArr.every(rx => entry.sets[idx]?.[rx]);
      if (allThisDone) {
        entry.done = true;
        entry.by = { team: normalizeTeamName(team), rsn, itemName, ts: Date.now(), setIndex: idx };
        return true;
      }
    }
    return false;
  }

  if (tile.type === "pet") return false;
  return false;
}

// ------- Board rendering (per-team) -------
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = (text || "").split(/\s+/);
  let line = "";
  for (let n = 0; n < words.length; n++) {
    const testLine = line ? line + " " + words[n] : words[n];
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n];
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
}

async function renderBoardBuffer(teamLabel) {
  const team = normalizeTeamName(teamLabel);
  ensureTeamBucket(team);

  // --- Layout constants ---
  const grid = 5;
  const boardWidth = 1100;   // square play area for 5x5 grid (higher res)
  const titleH = 120;        // taller header so it’s readable
  const pad = 14;            // inner cell text padding
  const cell = boardWidth / grid;

  const width  = boardWidth;            // image width
  const height = titleH + boardWidth;   // image height = title + board area

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Background & title
  ctx.fillStyle = "#000000ff"; // slate-800
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#3f3f3fff"; // slate-900 (title bar)
  ctx.fillRect(0, 0, width, titleH);

  ctx.fillStyle = "#e5e7eb"; // gray-200
  ctx.font = "bold 34px Arial";
  ctx.fillText("Fall Bingo Cookout", 24, 58);
  ctx.font = "bold 22px Arial";
  ctx.fillText(`Team: ${team}`, 24, 92);

  // Draw cells
  for (let i = 0; i < data.tiles.length; i++) {
    const row = Math.floor(i / grid);
    const col = i % grid;

    const x = col * cell;
    const y = titleH + row * cell; // note: start after title bar

    const tile = data.tiles[i];
    const state = tile?.inactive ? "inactive" : getTileStateForTeam(tile, team);

    // Cell background
    if (tile?.inactive) {
      ctx.fillStyle = "#000000ff";
    } else {
      ctx.fillStyle = state === "done" ? "#14532d" : "#000000ff"; // green-900 / gray-700
    }
    ctx.fillRect(x, y, cell, cell);

    // Border
    ctx.strokeStyle = "#ffffffff"; // gray-400
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cell, cell);

    // Tile label
    if (tile) {
      ctx.fillStyle = "#ffffffff";
      ctx.font = "bold 20px Arial";             // slightly larger
      const textX = x + pad;
      const textY = y + 30;
      const maxWidth = cell - pad * 2;
      wrapText(ctx, tile.name, textX, textY, maxWidth, 24); // slightly larger line height
    }

    // Progress badge (larger & clearer)
    try {
      if (!tile?.inactive) {
        const bucket = (data.completedByTeam?.[team] || {});
        const c = bucket[tile.key];
        if (c && !c.done) {
          let badge = "";
          if (tile.type === "anyCount") {
            const cur = c?.progress?.total || 0;
            badge = `${cur}/${tile.count}`;
          } else if (tile.type === "setAll") {
            const have = Object.keys(c?.sets?.collected || {}).length;
            const total = Array.isArray(tile.set) ? tile.set.length : 0;
            badge = `${have}/${total || "?"}`;
          } else if (tile.type === "orCount") {
            if (c?.by?.alt) badge = "ALT";
            else {
              const cur = c?.progress?.total || 0;
              badge = `${cur}/${tile.count}`;
            }
          } else if (tile.type === "orSetAll") {
            const sets = Array.isArray(tile.sets) ? tile.sets : [];
            const counts = sets.map((setArr, idx) => {
              const got = Object.keys((c?.sets && c.sets[idx]) || {}).length;
              return { got, total: Array.isArray(setArr) ? setArr.length : 0 };
            });
            const best = counts.sort((a,b)=>b.got-a.got)[0] || { got: 0, total: (sets[0]?.length || 0) };
            badge = `${best.got}/${best.total || "?"}`;
          }

          if (badge) {
            const bw = 80, bh = 30; // bigger badge
            ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
            ctx.fillRect(x + cell - bw - 10, y + cell - bh - 10, bw, bh);
            ctx.fillStyle = "#e5e7eb";
            ctx.font = "bold 18px Arial"; // bigger text
            ctx.fillText(badge, x + cell - bw + 10, y + cell - 12);
          }
        }
      }
    } catch (e) {
      console.error("[BOARD] badge render error for tile", tile?.key, "team", team, e);
    }

    // Checkmark overlay (a bit thicker)
    if (!tile?.inactive && state === "done") {
      ctx.strokeStyle = "#22c55e"; // green-500
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(x + cell * 0.18, y + cell * 0.58);
      ctx.lineTo(x + cell * 0.40, y + cell * 0.78);
      ctx.lineTo(x + cell * 0.82, y + cell * 0.32);
      ctx.stroke();
    }
  }

  return canvas.toBuffer("image/png");
}


async function postBoardImage(targetChannel, teamLabel, note = "") {
  const ch = targetChannel || bingoChannel;
  if (!ch) { console.warn("[BOARD] No channel to post to."); return; }
  const team = normalizeTeamName(teamLabel);
  try {
    const buf = await renderBoardBuffer(team);
    await ch.send({
      content: note || "",
      files: [{ attachment: buf, name: `bingo_${team.replace(/\s+/g,'_')}.png` }]
    });
  } catch (e) {
    console.error("[BOARD] Failed to send image:", e);
    throw e;
  }
}

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

let bingoChannel = null;

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      {
        body: [
          {
            name: "bingo-setchannel",
            description: "Set the channel for bingo drops",
            options: [{ name: "channel", type: 7, description: "Target channel", required: true }],
          },
          { name: "bingo-password", description: "Reveal the bingo password (and start time)" },

          {
            name: "bingo-board",
            description: "Post the current visual bingo board image for a team",
            options: [
              { name: "team", type: 3, description: "Team name", required: true, autocomplete: true }
            ]
          },
          {
            name: "bingo-add",
            description: "Simulate a drop (manual progress) for a team",
            options: [
              { name: "team",  type: 3, description: "Team name", required: true, autocomplete: true },
              { name: "rsn",   type: 3, description: "Player RSN", required: true, autocomplete: true },
              { name: "item",  type: 3, description: "Item name as it would appear", required: true, autocomplete: true }
            ]
          },
          {
            name: "bingo-mark",
            description: "Manually mark a tile complete for a team (e.g., PET/edge cases)",
            options: [
              { name: "tilekey", type: 3, description: "Tile key", required: true, autocomplete: true },
              { name: "rsn",     type: 3, description: "Player RSN", required: true, autocomplete: true },
              { name: "team",    type: 3, description: "Team name", required: true, autocomplete: true }
            ]
          },
          {
            name: "bingo-setteam",
            description: "Assign an RSN to a team",
            options: [
              { name: "rsn",  type: 3, description: "Player RSN", required: true, autocomplete: true },
              { name: "team", type: 3, description: "Team name (free text)", required: true, autocomplete: true }
            ]
          },
          { name: "bingo-teams", description: "Show current RSN → Team assignments" },
          {
            name: "bingo-status",
            description: "Show progress summary for a team",
            options: [
              { name: "team", type: 3, description: "Team name", required: true, autocomplete: true }
            ]
          },
          {
  name: "bingo-deleteteam",
  description: "Remove a team bucket and unassign RSNs from that team",
  options: [
    { name: "team", type: 3, description: "Team name", required: true, autocomplete: true }
  ]
},
{
  name: "bingo-unsetteam",
  description: "Remove a single RSN→Team assignment",
  options: [
    { name: "rsn", type: 3, description: "Player RSN", required: true, autocomplete: true }
  ]
},
{
  name: "bingo-unmark",
  description: "Undo a marked or partial tile for a team",
  options: [
    { name: "tilekey", type: 3, description: "Tile key", required: true },
    { name: "team", type: 3, description: "Team name", required: true }
  ]
}


        ],
      }
    );
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }

  if (data.channelId) {
    try {
      const ch = await client.channels.fetch(data.channelId);
      if (ch) bingoChannel = ch;
      console.log("[INIT] Restored bingo channel:", ch?.id || "(none)");
    } catch {}
  }
});

// --- Interactions (Autocomplete + Commands) ---
client.on("interactionCreate", async (i) => {
  // AUTOCOMPLETE
  if (i.isAutocomplete()) {
    try {
      const focused = i.options.getFocused(true); // { name, value }
      const q = (focused.value || "").toLowerCase();

      let choices = [];
      if (i.commandName === "bingo-board" && focused.name === "team") {
        choices = allTeamNames();
      } else if (i.commandName === "bingo-mark") {
        if (focused.name === "team")       choices = allTeamNames();
        else if (focused.name === "rsn")   choices = allRSNs();
        else if (focused.name === "tilekey") choices = allTileKeys();
      } else if (i.commandName === "bingo-add") {
        if (focused.name === "team")       choices = allTeamNames();
        else if (focused.name === "rsn")   choices = allRSNs();
        else if (focused.name === "item")  choices = allItemSuggestions();
      } else if (i.commandName === "bingo-setteam") {
        if (focused.name === "team") choices = allTeamNames();
        else if (focused.name === "rsn") choices = allRSNs();
      } else if (i.commandName === "bingo-status") {
        if (focused.name === "team") choices = allTeamNames();
      }

      const filtered = choices
        .filter(s => s.toLowerCase().includes(q))
        .slice(0, 25)
        .map(s => ({ name: s, value: s }));

      await i.respond(filtered.length ? filtered : [{ name: "No matches", value: "" }]);
    } catch (e) {
      console.error("[AUTOCOMPLETE] error:", e);
      try { await i.respond([]); } catch {}
    }
    if (i.commandName === "bingo-deleteteam") {
  try {
    await i.deferReply({ flags: 64 });
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
      return i.editReply("Need Manage Server permission.");

    const teamRaw = i.options.getString("team");
    const team = normalizeTeamName(teamRaw || "");
    if (!team) return i.editReply("Team is required.");

    // Unassign RSNs that point to this team
    const removed = [];
    for (const [rsn, t] of Object.entries(data.rsnToTeam || {})) {
      if (normalizeTeamName(t) === team) {
        delete data.rsnToTeam[rsn];
        removed.push(rsn);
      }
    }
    // Remove team progress bucket
    if (data.completedByTeam?.[team]) {
      delete data.completedByTeam[team];
    }
    saveData(data);

    return i.editReply(`Deleted team **${team}**. Unassigned RSNs: ${removed.length ? removed.join(", ") : "(none)"}`);
  } catch (err) {
    console.error("Error in /bingo-deleteteam:", err);
    if (!i.replied) try { await i.editReply("Error deleting team."); } catch {}
  }
}

if (i.commandName === "bingo-unsetteam") {
  try {
    await i.deferReply({ flags: 64 });
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
      return i.editReply("Need Manage Server permission.");

    const rsn = i.options.getString("rsn")?.trim();
    if (!rsn) return i.editReply("RSN is required.");

    if (data.rsnToTeam?.[rsn]) {
      delete data.rsnToTeam[rsn];
      saveData(data);
      return i.editReply(`Unassigned **${rsn}** from any team.`);
    } else {
      return i.editReply(`**${rsn}** wasn’t assigned to a team.`);
    }
  } catch (err) {
    console.error("Error in /bingo-unsetteam:", err);
    if (!i.replied) try { await i.editReply("Error unassigning RSN."); } catch {}
  }
}

    return; // don't fall through
  }

  // CHAT COMMANDS
  if (!i.isChatInputCommand()) return;

  if (i.commandName === "bingo-setchannel") {
    try {
      await i.deferReply({ flags: 64 });
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
        return i.editReply("Need Manage Server permission.");
      const ch = i.options.getChannel("channel");
      bingoChannel = ch;
      data.channelId = ch.id;
      saveData(data);
      return i.editReply(`Bingo drops channel set to ${ch}`);
    } catch (err) {
      console.error("Error in /bingo-setchannel:", err);
      if (!i.replied) try { await i.editReply("Error setting channel."); } catch {}
    }
  }

  if (i.commandName === "bingo-password") {
    try {
      await i.deferReply({ flags: 64 });
      await i.editReply(
        `The bingo password is: **${PASSWORD}** (active starting <t:${Math.floor(
          START_TIME.getTime() / 1000
        )}:F>)`
      );
    } catch (err) {
      console.error("Error in /bingo-password:", err);
      if (!i.replied) try { await i.editReply("Error showing password."); } catch {}
    }
  }

  if (i.commandName === "bingo-status") {
    try {
      await i.deferReply({ flags: 64 });
      const team = normalizeTeamName(i.options.getString("team")?.trim() || "");
      if (!team) return i.editReply("Team is required.");

      const bucket = data.completedByTeam?.[team] || {};
      const total = data.tiles.length;
      const done = data.tiles.filter(t => bucket[t.key]?.done).length;

      const lines = data.tiles.map(t => {
        const c = bucket[t.key];
        if (!c || !c.done) {
          if (t.type === "anyCount") {
            const cur = c?.progress?.total || 0;
            return `• ${t.key}: ${t.name} — ${cur}/${t.count}`;
          }
          if (t.type === "orCount") {
            const cur = c?.progress?.total || 0;
            return `• ${t.key}: ${t.name} — ${cur}/${t.count} (or alt)`;
          }
          if (t.type === "setAll") {
            const have = Object.keys(c?.sets?.collected || {}).length;
            return `• ${t.key}: ${t.name} — ${have}/${t.set.length}`;
          }
          if (t.type === "orSetAll") {
            const counts = (t.sets || []).map((setArr, idx) => {
              const got = Object.keys((c?.sets && c.sets[idx]) || {}).length;
              return { idx, got, total: (setArr || []).length };
            });
            const best = counts.sort((a, b) => b.got - a.got)[0] || { got: 0, total: (t.sets?.[0]?.length || 4) };
            return `• ${t.key}: ${t.name} — best set ${best.got}/${best.total}`;
          }
        }
        return `• ${t.key}: ${t.name} — DONE`;
      });

      return i.editReply({ content: `**${team}** Progress: ${done}/${total}\n` + lines.join("\n") });
    } catch (err) {
      console.error("Error in /bingo-status:", err);
      if (!i.replied) try { await i.editReply("Error building status. Check logs."); } catch {}
    }
  }

  if (i.commandName === "bingo-board") {
    try {
      await i.deferReply({ flags: 64 });
      const team = normalizeTeamName(i.options.getString("team")?.trim() || "");
      if (!team) return i.editReply("Team is required.");

      const buf = await renderBoardBuffer(team);
      await i.editReply({
        content: `Current Bingo Board — **${team}**`,
        files: [{ attachment: buf, name: `bingo_${team.replace(/\s+/g,'_')}.png` }]
      });
    } catch (err) {
      console.error("Error in /bingo-board:", err);
      if (!i.replied) {
        try { await i.editReply("Error generating board image."); } catch {}
      }
    }
  }

  if (i.commandName === "bingo-mark") {
    try {
      await i.deferReply({ flags: 64 });
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.editReply("Need Manage Server permission.");
      }

      const key  = i.options.getString("tilekey");
      const rsn  = i.options.getString("rsn");
      const team = normalizeTeamName(i.options.getString("team"));

      console.log("[/bingo-mark]", { key, rsn, team });

      const tile = data.tiles.find(t => t.key === key);
      if (!tile) return i.editReply("Unknown tile key.");

      ensureTeamBucket(team);
      const e = ensureTileProgressForTeam(tile, team);
      e.done = true;
      e.by = { team, rsn, itemName: "(manual)", ts: Date.now() };
      saveData(data);

      if (bingoChannel) {
        const embed = new EmbedBuilder()
          .setTitle("Bingo Tile Completed! (Manual)")
          .setDescription(`**${rsn}** completed **${tile.name}** for **${team}**`)
          .addFields({ name: "Tile Key", value: tile.key, inline: true })
          .setFooter({ text: "OSRS Bingo" });

        await bingoChannel.send({ embeds: [embed] });
        await postBoardImage(bingoChannel, team);
      }

      return i.editReply(`Marked \`${key}\` complete for **${team}**.`);
    } catch (err) {
      console.error("Error in /bingo-mark:", err);
      if (!i.replied) {
        try { await i.editReply("Something went wrong running /bingo-mark. Check logs."); } catch {}
      }
    }
  }

  if (i.commandName === "bingo-add") {
    try {
      await i.deferReply({ flags: 64 });

      const team = normalizeTeamName(i.options.getString("team")?.trim() || "");
      const rsn  = i.options.getString("rsn")?.trim();
      const item = i.options.getString("item")?.trim();

      if (!team || !rsn || !item) {
        return i.editReply("Missing team/rsn/item.");
      }

      console.log("[/bingo-add]", { team, rsn, item });

      ensureTeamBucket(team);

      const before = JSON.stringify(data.completedByTeam?.[team] || {});
      await processParsedDrop(rsn, team, item);
      const after  = JSON.stringify(data.completedByTeam?.[team] || {});

      if (before === after) {
        return i.editReply(`No matching tile for **${item}** on **${team}**. Check your item spelling or tile rules.`);
      }

      return i.editReply(`Recorded **${item}** for **${rsn}** on **${team}**.`);
    } catch (err) {
      console.error("Error in /bingo-add:", err);
      if (!i.replied) try { await i.editReply("Error adding drop. Check logs."); } catch {}
    }
  }

  if (i.commandName === "bingo-setteam") {
    try {
      await i.deferReply({ flags: 64 });
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
        return i.editReply("Need Manage Server permission.");

      const rsn = i.options.getString("rsn")?.trim();
      const teamRaw = i.options.getString("team")?.trim();
      const team = normalizeTeamName(teamRaw || "");
      if (!rsn || !team) return i.editReply("Both RSN and Team are required.");

      data.rsnToTeam[rsn] = team;
      ensureTeamBucket(team);
      saveData(data);
      return i.editReply(`Assigned **${rsn}** to **${team}**.`);
    } catch (err) {
      console.error("Error in /bingo-setteam:", err);
      if (!i.replied) try { await i.editReply("Error setting team."); } catch {}
    }
  }

  if (i.commandName === "bingo-teams") {
    const entries = Object.entries(data.rsnToTeam || {});
    if (!entries.length) {
      return i.reply({ flags: 64, content: "No RSN → Team assignments yet." });
    }
    const byTeam = entries.reduce((acc, [rsn, team]) => {
      const t = normalizeTeamName(team);
      acc[t] = acc[t] || [];
      acc[t].push(rsn);
      return acc;
    }, {});
    const lines = Object.keys(byTeam).sort().map(team => `**${team}**: ${byTeam[team].join(", ")}`);
    return i.reply({ flags: 64, content: lines.join("\n") });
  }
  if (i.commandName === "bingo-unmark") {
  try {
    await i.deferReply({ flags: 64 });

    const key = i.options.getString("tilekey");
    const team = i.options.getString("team");

    const tile = data.tiles.find(t => t.key === key);
    if (!tile) return i.editReply("Unknown tile key.");

    const bucket = data.completedByTeam[team];
    if (!bucket || !bucket[key]) {
      return i.editReply(`Tile \`${key}\` wasn’t marked for **${team}**.`);
    }

    // Reset that tile’s state
    delete bucket[key];
    saveData(data);

    await i.editReply(`Tile \`${key}\` has been unmarked/reset for **${team}**.`);

    // Optional: repost updated board
    if (bingoChannel) await postBoardImage(bingoChannel, team);

  } catch (err) {
    console.error("Error in /bingo-unmark:", err);
    if (!i.replied) try { await i.editReply("Error unmarking tile."); } catch {}
  }
}

});

// --- Health check ---
app.get("/", (_req, res) => res.send("OK"));

// --- Optional HMAC verify ---
function verifySignature(rawBody, signature) {
  if (!BINGO_WEBHOOK_SECRET) return true;
  try {
    const hmac = crypto
      .createHmac("sha256", BINGO_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
    return hmac === signature;
  } catch {
    return false;
  }
}

// --- /drops (future plugin path; team-scoped) ---
app.post("/drops", (req, res) => {
  const now = new Date();
  if (now < START_TIME) return res.status(403).json({ error: "Bingo not started yet." });

  const sig = req.headers["x-bingo-signature"];
  const rawBody = JSON.stringify(req.body || {});
  if (!verifySignature(rawBody, sig)) return res.status(401).json({ error: "Bad signature" });

  const { password, itemName, player } = req.body || {};
  if (password !== PASSWORD) return res.status(403).json({ error: "Invalid password." });
  if (!bingoChannel) return res.status(400).json({ error: "No bingo channel set." });
  if (!itemName || !player) return res.status(400).json({ error: "Missing itemName/player" });

  const team = findTeamByRSN(player);
  processParsedDrop(player, team, itemName);
  return res.json({ ok: true });
});

// Replace your current client.on("messageCreate", ...) with this:
client.on("messageCreate", async (msg) => {
  // Only listen in the configured channel
  if (!bingoChannel || msg.channel.id !== bingoChannel.id) return;

  // Dink posts via webhook/bot
  if (!msg.author.bot) return;

  const e = msg.embeds?.[0];
  const rawContent = msg.content || "";
  const authorName = e?.author?.name || "";
  const title = e?.title || "";
  const desc = e?.description || "";

  // Build text corpus
  const parts = [
    authorName, title, desc,
    ...(Array.isArray(e?.fields) ? e.fields.flatMap(f => [f?.name, f?.value]) : []),
    rawContent
  ].filter(Boolean);
  const text = parts.join("\n");

  console.log("[DINK RAW] ----------");
  console.log("author:", msg.author?.username, "webhookId:", msg.webhookId);
  if (e) console.log("embed snapshot:", JSON.stringify({
    author: e.author, title: e.title, description: e.description, fields: e.fields
  }, null, 2));
  console.log("---------------------");

  // Parse player (RSN)
  // 1) Some Dink templates put RSN as the first line of the description (e.g., "Bloviating")
  //    followed by "has looted:"
  let player = null;

  // A: "Bloviating has looted:"
  let mPl = text.match(/^([A-Za-z0-9 _\-]+)\s+has\s+looted\s*:?\s*$/im);
  if (mPl) player = mPl[1].trim();

  // B: If not, the first non-empty line of description often IS the RSN
  if (!player && desc) {
    const first = desc.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && !/has\s+looted/i.test(first)) player = first;
  }

  // C: Fallback: embed author sometimes carries RSN
  if (!player && authorName) player = authorName.trim();

  // D: Fallback: first non-empty content line
  if (!player && rawContent) {
    const first = rawContent.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first) player = first;
  }

  // Parse item line like "1 x Pegasian crystal (160K)" → "Pegasian crystal"
  let itemName = null;
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    // "1 x Item Name (price)" or "2 x Item Name"
    let m = line.match(/\b\d+\s*x\s+([^(]+?)(?:\s*\([^)]*\))?$/i);
    if (m) { itemName = m[1].trim(); break; }
    // "Item: Item Name (price)"
    m = line.match(/^item\s*:\s*([^(]+?)(?:\s*\([^)]*\))?$/i);
    if (m) { itemName = m[1].trim(); break; }
  }

  if (itemName) {
    itemName = itemName.replace(/[’]/g, "'").replace(/\s{2,}/g, " ").trim();
  }

  console.log("[DINK PARSE]", { player, itemName });

  if (!player || !itemName) {
    console.warn("[DINK PARSE MISS] Could not extract player or item from Dink embed.");
    return;
  }

  const team = findTeamByRSN(player);
  await processParsedDrop(player, team, itemName);
});



// Replace your current processParsedDrop with this:
const CELEB = ["🎉","🏆","💎","🔥","🍀","🎯","✨"];

async function processParsedDrop(rsn, team, itemName) {
  if (!bingoChannel) return;

  if (!team || team === "Unassigned") {
    await bingoChannel.send(`Heads-up: **${rsn}** isn’t assigned to a team. Use \`/bingo-setteam\`.`);
    return;
  }

  let matchedAny = false;
  let completedSomething = false;

  for (const tile of data.tiles) {
    if (tile.inactive) continue;
    if (!matchTile(tile, itemName)) continue;

    matchedAny = true;

    // ensure bucket exists
    ensureTeamBucket(team);

    // update progress
    const justCompleted = handleProgressForTeam(tile, team, rsn, itemName);
    const bucket = data.completedByTeam[team];
    const c = bucket[tile.key];

    // Congratulate on the drop itself
    await bingoChannel.send(`${CELEB[Math.floor(Math.random()*CELEB.length)]} **${rsn}** (${team}) got **${itemName}**`);

    if (justCompleted) {
      completedSomething = true;
      saveData(data);

      const embed = new EmbedBuilder()
        .setTitle("Bingo Tile Completed!")
        .setDescription(`${CELEB[Math.floor(Math.random()*CELEB.length)]} **${rsn}** completed **${tile.name}** for **${team}**`)
        .addFields({ name: "Tile Key", value: tile.key, inline: true })
        .setFooter({ text: "OSRS Bingo" });

      await bingoChannel.send({ embeds: [embed] });
      await postBoardImage(bingoChannel, team);
    } else {
      // Partial progress message
      if (tile.type === "anyCount") {
        await bingoChannel.send(`Progress (**${team}**): **${tile.name}** — ${c.progress.total}/${tile.count}`);
      } else if (tile.type === "orCount") {
        if (c.by?.alt) {
          // alt path completes immediately, but if we’re here it wasn’t alt yet
        } else {
          await bingoChannel.send(`Progress (**${team}**): **${tile.name}** — ${c.progress.total}/${tile.count} (or ALT)`);
        }
      } else if (tile.type === "setAll") {
        const have = Object.keys(c.sets.collected || {}).length;
        await bingoChannel.send(`Progress (**${team}**): **${tile.name}** — ${have}/${tile.set.length}`);
      } else if (tile.type === "orSetAll") {
        const sets = tile.sets || [];
        const counts = sets.map((setArr, idx) => {
          const got = Object.keys((c.sets && c.sets[idx]) || {}).length;
          return { got, total: (Array.isArray(setArr) ? setArr.length : 0) };
        });
        counts.sort((a,b)=>b.got-a.got);
        const best = counts[0] || { got: 0, total: (sets[0]?.length || 0) };
        await bingoChannel.send(`Progress (**${team}**): **${tile.name}** — best set ${best.got}/${best.total}`);
      }
      saveData(data);
    }
  }

  if (!matchedAny) {
    await bingoChannel.send(`No tile matched **${itemName}** for **${team}**. If this should match, tweak its \`matches\`/regex in \`bingo.json\`.`);
  }
}


// --- Start HTTP + Discord ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listening on ${PORT}`));
client.login(DISCORD_TOKEN);

// Crash guards
process.on("unhandledRejection", (r) => console.error("[UNHANDLED REJECTION]", r));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT EXCEPTION]", e));

