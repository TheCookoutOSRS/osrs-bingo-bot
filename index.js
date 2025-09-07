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
import { createCanvas } from "@napi-rs/canvas"; // <-- using napi canvas (Render-friendly)

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
const DATA_PATH = "./bingo.json";
function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(
      DATA_PATH,
      JSON.stringify(
        {
          rsnToTeam: {},   // { "RSN": "Team Name" }
          tiles: [],       // tile rules
          completedByTeam: {}, // { "Team": { tileKey: {done, by, progress...} } }
          channelId: ""
        },
        null, 2
      )
    );
  }
  const d = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  // migrate legacy
  if (d.completed && !d.completedByTeam) {
    console.warn("[MIGRATE] Found legacy 'completed'. Creating completedByTeam.GLOBAL.");
    d.completedByTeam = { GLOBAL: d.completed };
    delete d.completed;
    fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
  }
  if (!d.completedByTeam) d.completedByTeam = {};
  return d;
}
function saveData(d) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
}
let data = loadData();

// ------- Helpers -------
function normalizeTeamName(s = "") {
  // Normalize curly apostrophes and trim whitespace
  return String(s).replace(/[’]/g, "'").trim();
}

function findTeamByRSN(rsn) {
  // Team names in file are authoritative; normalize at lookup
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
    // We track best progress by set index
    entry.sets = entry.sets || {};
    const sets = tile.sets || [];
    for (let idx = 0; idx < sets.length; idx++) {
      const setArr = sets[idx] || [];
      const matchInThisSet = setArr.find(rx => new RegExp(rx, "i").test(itemName));
      if (matchInThisSet) {
        entry.sets[idx] = entry.sets[idx] || {};
        entry.sets[idx][matchInThisSet] = true;
      }
      // check completion for this set
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
  // Make sure bucket exists so lookups don't fail and board never blanks
  ensureTeamBucket(team);

  const size = 1000;       // image px
  const grid = 5;
  const titleH = 70;
  const pad = 12;
  const cell = size / grid;

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Background & title
  ctx.fillStyle = "#1f2937"; // slate-800
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#111827"; // slate-900
  ctx.fillRect(0, 0, size, titleH);
  ctx.fillStyle = "#e5e7eb"; // gray-200
  ctx.font = "bold 28px Arial";
  ctx.fillText("Fall Bingo Cookout", 20, 42);
  ctx.font = "bold 20px Arial";
  ctx.fillText(`Team: ${team}`, 20, 64);

  // Grid cells
  for (let i = 0; i < data.tiles.length; i++) {
    const row = Math.floor(i / grid);
    const col = i % grid;
    const x = col * cell;
    const y = row * cell + titleH;

    const tile = data.tiles[i];
    const state = tile?.inactive ? "inactive" : getTileStateForTeam(tile, team);

    // Cell background
    if (tile?.inactive) {
      ctx.fillStyle = "#000000";
    } else {
      ctx.fillStyle = state === "done" ? "#14532d" : "#374151"; // green-900 or gray-700
    }
    ctx.fillRect(x, y, cell, cell);

    // Border
    ctx.strokeStyle = "#9ca3af"; // gray-400
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cell, cell);

    // Text
    if (tile) {
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "bold 18px Arial";
      const textX = x + pad;
      const textY = y + 28;
      const maxWidth = cell - pad * 2;
      wrapText(ctx, tile.name, textX, textY, maxWidth, 22);
    }

    // Progress badge for in-progress tiles (safe)
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
            if (c?.by?.alt) {
              badge = "ALT";
            } else {
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
            // small badge bottom-right
            const padBR = 8;
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fillRect(x + cell - 60, y + cell - 28, 52, 20);
            ctx.fillStyle = "#e5e7eb";
            ctx.font = "bold 14px Arial";
            ctx.fillText(badge, x + cell - 48, y + cell - 14);
          }
        }
      }
    } catch (e) {
      console.error("[BOARD] badge render error for tile", tile?.key, "team", team, e);
      // continue rendering the rest of the board
    }

    // Checkmark overlay
    if (!tile?.inactive && state === "done") {
      ctx.strokeStyle = "#22c55e"; // green-500
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(x + cell * 0.2, y + cell * 0.55);
      ctx.lineTo(x + cell * 0.4, y + cell * 0.75);
      ctx.lineTo(x + cell * 0.8, y + cell * 0.3);
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
    throw e; // so the handler shows a clear error
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
            options: [{ name: "team", type: 3, description: "Team name", required: true }]
          },
          {
            name: "bingo-add",
            description: "Simulate a drop (manual progress) for a team",
            options: [
              { name: "team",  type: 3, description: "Team name", required: true },
              { name: "rsn",   type: 3, description: "Player RSN", required: true },
              { name: "item",  type: 3, description: "Item name as it would appear", required: true }
            ]
          },
          {
            name: "bingo-mark",
            description: "Manually mark a tile complete for a team (e.g., PET/edge cases)",
            options: [
              { name: "tilekey", type: 3, description: "Tile key", required: true },
              { name: "rsn",     type: 3, description: "Player RSN", required: true },
              { name: "team",    type: 3, description: "Team name", required: true }
            ]
          },
          {
            name: "bingo-setteam",
            description: "Assign an RSN to a team",
            options: [
              { name: "rsn",  type: 3, description: "Player RSN", required: true },
              { name: "team", type: 3, description: "Team name (free text)", required: true }
            ]
          },
          { name: "bingo-teams", description: "Show current RSN → Team assignments" }
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

client.on("interactionCreate", async (i) => {
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
      await i.deferReply({ flags: 64 }); // ephemeral
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
      await i.deferReply({ flags: 64 }); // ephemeral ack

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
      await i.deferReply({ flags: 64 }); // ACK immediately (ephemeral)

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
      await i.deferReply({ flags: 64 }); // ACK immediately

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

// --- Parse webhook posts in #bingo-drops (Dink etc.; team-scoped) ---
client.on("messageCreate", async (msg) => {
  if (!bingoChannel || msg.channel.id !== bingoChannel.id) return;

  if (!msg.author.bot) return;

  let text = msg.content || "";
  if (!text && msg.embeds?.length) {
    const e = msg.embeds[0];
    text = [e?.title, e?.description].filter(Boolean).join(" ");
  }
  if (!text) return;

  console.log("[DINK RAW]", text);

  let m =
    text.match(/by\s+\**(.+?)\**.*?:\s+\**(.+?)\**/i) ||
    text.match(/^\**?(.+?)\**?.*?received\s+\**(.+?)\**/i) ||
    text.match(/^\**?(.+?)\**?:\s+\**(.+?)\**/i);

  if (!m) {
    console.warn("[DINK PARSE MISS]");
    return;
  }
  const [, player, itemName] = m;
  const team = findTeamByRSN(player);
  await processParsedDrop(player, team, itemName);
});

const CELEB = ["🎉","🏆","💎","🔥","🍀","🎯","✨"];

async function processParsedDrop(rsn, teamRaw, itemName) {
  const team = normalizeTeamName(teamRaw);
  if (!team || team === "Unassigned") {
    await bingoChannel?.send(`(Heads-up) **${rsn}** isn’t assigned to a team. Use \`/bingo-setteam\`.`);
    return;
  }

  let hitAny = false;

  for (const tile of data.tiles) {
    if (tile.inactive) continue;
    if (!matchTile(tile, itemName)) continue;

    hitAny = true;

    const justCompleted = handleProgressForTeam(tile, team, rsn, itemName);
    const bucket = ensureTeamBucket(team);
    const c = bucket[tile.key];

    // Announce drop line always
    await bingoChannel?.send(`${CELEB[Math.floor(Math.random()*CELEB.length)]} **${rsn}** (${team}) got **${itemName}**`);

    if (!justCompleted) {
      if (tile.type === "anyCount") {
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — ${c.progress.total}/${tile.count}`);
      } else if (tile.type === "orCount") {
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — ${c.progress.total}/${tile.count} (or ALT)`);
      } else if (tile.type === "setAll") {
        const have = Object.keys(c.sets.collected || {}).length;
        const total = (tile.set || []).length;
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — ${have}/${total}`);
      } else if (tile.type === "orSetAll") {
        const counts = (tile.sets || []).map((setArr, idx) => {
          const got = Object.keys((c.sets && c.sets[idx]) || {}).length;
          return { got, total: (setArr || []).length };
        }).sort((a,b)=>b.got-a.got);
        const best = counts[0] || { got: 0, total: (tile.sets?.[0]?.length || 4) };
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — best set ${best.got}/${best.total}`);
      }
      saveData(data);
      continue;
    }

    saveData(data);
    const embed = new EmbedBuilder()
      .setTitle("Bingo Tile Completed!")
      .setDescription(`${CELEB[Math.floor(Math.random()*CELEB.length)]} **${rsn}** completed **${tile.name}** for **${team}**`)
      .addFields({ name: "Tile Key", value: tile.key, inline: true })
      .setFooter({ text: "OSRS Bingo" });

    await bingoChannel?.send({ embeds: [embed] });
    await postBoardImage(bingoChannel, team);
  }

  if (!hitAny) {
    await bingoChannel?.send(`No tile matched **${itemName}** for **${team}**. (If this should match, tweak the tile regex in \`bingo.json\`.)`);
  }
}


// --- Start HTTP + Discord ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listening on ${PORT}`));
client.login(DISCORD_TOKEN);

// Crash guards
process.on("unhandledRejection", (r) => console.error("[UNHANDLED REJECTION]", r));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT EXCEPTION]", e));
