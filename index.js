// Boot logs
console.log("[BOOT] starting Cookout Bingo Bot...");

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import { createCanvas } from "@napi-rs/canvas";

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

// --- Data layer (seed /data from repo on first boot) ---
const PERSIST_DIR = "/data";
const REPO_DEFAULT_PATH = "./bingo.json";
const DATA_PATH = fs.existsSync(PERSIST_DIR)
  ? path.join(PERSIST_DIR, "bingo.json")
  : REPO_DEFAULT_PATH;

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    if (DATA_PATH.startsWith("/data") && fs.existsSync(REPO_DEFAULT_PATH)) {
      try {
        fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
        const src = JSON.parse(fs.readFileSync(REPO_DEFAULT_PATH, "utf8"));
        fs.writeFileSync(DATA_PATH, JSON.stringify(src, null, 2));
        console.log(
          `[DATA] Seeded ${DATA_PATH} from repo (tiles=${(src.tiles || []).length}, rsns=${Object.keys(
            src.rsnToTeam || {}
          ).length})`
        );
      } catch (e) {
        console.error("[DATA] Failed seeding from repo bingo.json:", e);
      }
    } else {
      fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
      fs.writeFileSync(
        DATA_PATH,
        JSON.stringify({ rsnToTeam: {}, tiles: [], completedByTeam: {}, channelId: "" }, null, 2)
      );
      console.warn(`[DATA] Created blank ${DATA_PATH}`);
    }
  }

  const d = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  // migrate legacy structure if present
  if (d.completed && !d.completedByTeam) {
    console.warn("[MIGRATE] Found legacy 'completed'. Creating completedByTeam.GLOBAL.");
    d.completedByTeam = { GLOBAL: d.completed };
    delete d.completed;
    fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
  }
  if (!d.completedByTeam) d.completedByTeam = {};

  console.log(
    `[DATA] Loaded tiles=${(d.tiles || []).length}; RSNs=${Object.keys(d.rsnToTeam || {}).length} from ${DATA_PATH}`
  );
  return d;
}
function saveData(d) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
}
let data = loadData();

// ------- Helpers -------
function normalizeKey(s = "") {
  return s.toLowerCase().replace(/[\s_]+/g, " ").trim();
}
function ensureTeamBucket(team) {
  if (!data.completedByTeam[team]) data.completedByTeam[team] = {};
  return data.completedByTeam[team];
}
function ensureTileProgressForTeam(tile, team) {
  const bucket = ensureTeamBucket(team);
  if (!bucket[tile.key]) {
    bucket[tile.key] = { done: false, by: null, progress: { total: 0 }, sets: {} };
  }
  return bucket[tile.key];
}
function matchTile(tile, itemName) {
  if (!tile || !itemName) return false;

  if (tile.type === "single") return tile.matches.some((rx) => new RegExp(rx, "i").test(itemName));
  if (tile.type === "anyCount") return tile.sources.some((rx) => new RegExp(rx, "i").test(itemName));
  if (tile.type === "setAll") return tile.set.some((rx) => new RegExp(rx, "i").test(itemName));
  if (tile.type === "orSetAll") return tile.sets.flat().some((rx) => new RegExp(rx, "i").test(itemName));
  if (tile.type === "orCount") {
    const inCountGroup = tile.sources.some((rx) => new RegExp(rx, "i").test(itemName));
    const inAlt = (tile.alternativeMatches || []).some((rx) => new RegExp(rx, "i").test(itemName));
    return inCountGroup || inAlt;
  }
  if (tile.type === "pet") return false; // manual only
  return false;
}
function handleProgressForTeam(tile, team, rsn, itemName) {
  const entry = ensureTileProgressForTeam(tile, team);
  if (entry.done) return false;

  if (tile.type === "single") {
    entry.done = true;
    entry.by = { team, rsn, itemName, ts: Date.now() };
    return true;
  }

  if (tile.type === "anyCount") {
    entry.progress.total = (entry.progress.total || 0) + 1;
    if (entry.progress.total >= tile.count) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now() };
      return true;
    }
    return false;
  }

  if (tile.type === "setAll") {
    if (!entry.sets.collected) entry.sets.collected = {};
    const matched = tile.set.find((rx) => new RegExp(rx, "i").test(itemName));
    if (matched) entry.sets.collected[matched] = true;
    const allDone = tile.set.every((rx) => entry.sets.collected[rx]);
    if (allDone) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now() };
      return true;
    }
    return false;
  }

  if (tile.type === "orSetAll") {
    if (!entry.sets) entry.sets = {};
    let completedIndex = null;
    for (let s = 0; s < tile.sets.length; s++) {
      const setArr = tile.sets[s];
      if (!entry.sets[s]) entry.sets[s] = {};
      const hit = setArr.find((rx) => new RegExp(rx, "i").test(itemName));
      if (hit) entry.sets[s][hit] = true;
      const allDone = setArr.every((rx) => entry.sets[s][rx]);
      if (allDone) {
        completedIndex = s;
        break;
      }
    }
    if (completedIndex !== null) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now() };
      entry.sets.completedIndex = completedIndex;
      return true;
    }
    return false;
  }

  if (tile.type === "orCount") {
    const inCountGroup = tile.sources.some((rx) => new RegExp(rx, "i").test(itemName));
    const inAlt = (tile.alternativeMatches || []).some((rx) => new RegExp(rx, "i").test(itemName));
    if (inAlt) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now(), alt: true };
      return true;
    }
    if (inCountGroup) {
      entry.progress.total = (entry.progress.total || 0) + 1;
      if (entry.progress.total >= tile.count) {
        entry.done = true;
        entry.by = { team, rsn, itemName, ts: Date.now() };
        return true;
      }
      return false;
    }
  }

  if (tile.type === "pet") return false;
  return false;
}
function findTeamByRSN(rsn) {
  return data.rsnToTeam?.[rsn] || "Unassigned";
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
function getTileStateForTeam(tile, team) {
  const bucket = data.completedByTeam?.[team] || {};
  const c = bucket[tile.key];
  return c && c.done ? "done" : "pending";
}
async function renderBoardBuffer(teamLabel) {
  const size = 1000, grid = 5, titleH = 70, pad = 12, cell = size / grid;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Background & title
  ctx.fillStyle = "#1f2937"; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, size, titleH);
  ctx.fillStyle = "#e5e7eb"; ctx.font = "bold 28px Arial";
  ctx.fillText("Fall Bingo Cookout", 20, 42);
  ctx.font = "bold 20px Arial"; ctx.fillText(`Team: ${teamLabel}`, 20, 64);

  for (let i = 0; i < data.tiles.length; i++) {
    const row = Math.floor(i / grid), col = i % grid;
    const x = col * cell, y = row * cell + titleH;
    const tile = data.tiles[i];
    const state = tile?.inactive ? "inactive" : getTileStateForTeam(tile, teamLabel);

    // cell bg
    ctx.fillStyle = tile?.inactive ? "#000000" : (state === "done" ? "#14532d" : "#374151");
    ctx.fillRect(x, y, cell, cell);

    // border
    ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 2; ctx.strokeRect(x, y, cell, cell);

    // text
    if (tile) {
      ctx.fillStyle = "#e5e7eb"; ctx.font = "bold 18px Arial";
      wrapText(ctx, tile.name, x + pad, y + 28, cell - pad * 2, 22);
    }

    // check
    if (!tile?.inactive && state === "done") {
      ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(x + cell * 0.2, y + cell * 0.55);
      ctx.lineTo(x + cell * 0.4, y + cell * 0.75);
      ctx.lineTo(x + cell * 0.8, y + cell * 0.3);
      ctx.stroke();
    }

    // progress badge
    if (!tile?.inactive) {
      const bucket = data.completedByTeam?.[teamLabel] || {};
      const c = bucket[tile.key];
      if (c && !c.done) {
        let badge = "";
        if (tile.type === "anyCount") badge = `${c.progress?.total || 0}/${tile.count}`;
        else if (tile.type === "setAll") {
          const have = Object.keys(c.sets?.collected || {}).length;
          badge = `${have}/${tile.set.length}`;
        } else if (tile.type === "orCount")
          badge = c.by?.alt ? "ALT" : `${c.progress?.total || 0}/${tile.count}`;
        else if (tile.type === "orSetAll") {
          const counts = tile.sets.map((setArr, idx) => {
            const got = Object.keys((c.sets && c.sets[idx]) || {}).length;
            return { got, total: setArr.length };
          });
          const best = counts.sort((a, b) => b.got - a.got)[0] || { got: 0, total: (tile.sets[0]?.length || 4) };
          badge = `${best.got}/${best.total}`;
        }
        if (badge) {
          ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(x + cell - 60, y + cell - 28, 52, 20);
          ctx.fillStyle = "#e5e7eb"; ctx.font = "bold 14px Arial";
          ctx.fillText(badge, x + cell - 48, y + cell - 14);
        }
      }
    }
  }

  return canvas.toBuffer("image/png");
}
async function postBoardImage(targetChannel, teamLabel, note = "") {
  const ch = targetChannel || bingoChannel;
  if (!ch) { console.warn("[BOARD] No channel to post to."); return; }
  try {
    const buf = await renderBoardBuffer(teamLabel);
    await ch.send({ content: note || "", files: [{ attachment: buf, name: `bingo_${teamLabel.replace(/\s+/g, "_")}.png` }] });
  } catch (e) {
    console.error("[BOARD] Failed to send image:", e);
    throw e;
  }
}

// --- Discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
let bingoChannel = null;

// ---------- AUTOCOMPLETE SUPPORT ----------
function getTeamsList() {
  const teams = new Set(Object.keys(data.completedByTeam || {}));
  Object.values(data.rsnToTeam || {}).forEach((t) => teams.add(t));
  return Array.from(teams).filter(Boolean).sort();
}
function getRsnsForTeam(team) {
  const out = [];
  for (const [rsn, t] of Object.entries(data.rsnToTeam || {})) {
    if (!team || t === team) out.push(rsn);
  }
  return out.sort();
}
function getItemAliases() {
  const names = new Set();
  for (const t of data.tiles || []) {
    const scrub = (rx) =>
      rx
        .replace(/\\\\/g, "\\")
        .replace(/\\s\+/g, " ")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\s+/g, " ")
        .trim();
    (t.matches || []).forEach((rx) => names.add(scrub(rx)));
    (t.sources || []).forEach((rx) => names.add(scrub(rx)));
    (t.set || []).forEach((rx) => names.add(scrub(rx)));
    (t.sets || []).flat().forEach((rx) => names.add(scrub(rx)));
    (t.alternativeMatches || []).forEach((rx) => names.add(scrub(rx)));
  }
  return Array.from(names).filter((s) => s && s.length <= 100).sort();
}

// Handle autocomplete interactions
client.on("interactionCreate", async (i) => {
  if (!i.isAutocomplete()) return;
  try {
    const focused = i.options.getFocused(true); // { name, value }
    const teamArg = i.options.getString("team");
    const value = (focused?.value || "").toLowerCase();
    let choices = [];

    if (focused.name === "team") {
      choices = getTeamsList();
    } else if (focused.name === "rsn") {
      choices = getRsnsForTeam(teamArg);
    } else if (focused.name === "item") {
      choices = getItemAliases();
    } else if (focused.name === "tilekey") {
      choices = (data.tiles || []).map((t) => t.key);
    }

    const filtered = choices
      .filter((c) => c.toLowerCase().includes(value))
      .slice(0, 25)
      .map((c) => ({ name: c, value: c }));

    await i.respond(filtered.length ? filtered : [{ name: "No matches", value: " " }]);
  } catch (err) {
    console.error("[AUTOCOMPLETE ERROR]", err);
    try { await i.respond([{ name: "Error", value: " " }]); } catch {}
  }
});

// ---------- READY + COMMAND REG ----------
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [
        {
          name: "bingo-setchannel",
          description: "Set the channel for bingo drops",
          options: [{ name: "channel", type: 7, description: "Target channel", required: true }],
        },
        { name: "bingo-password", description: "Reveal the bingo password (and start time)" },

        // Visual board (team autocomplete)
        {
          name: "bingo-board",
          description: "Post the current visual bingo board image for a team",
          options: [{ name: "team", type: 3, description: "Team name", required: true, autocomplete: true }],
        },

        // Manual drop with dropdowns
        {
          name: "bingo-add",
          description: "Simulate a drop (manual progress) for a team",
          options: [
            { name: "team", type: 3, description: "Team name", required: true, autocomplete: true },
            { name: "rsn",  type: 3, description: "Player RSN", required: true, autocomplete: true },
            { name: "item", type: 3, description: "Item name as it would appear", required: true, autocomplete: true },
          ],
        },

        // Manual mark with tilekey dropdown
        {
          name: "bingo-mark",
          description: "Manually mark a tile complete for a team (e.g., PET/edge cases)",
          options: [
            { name: "tilekey", type: 3, description: "Tile key", required: true, autocomplete: true },
            { name: "rsn",     type: 3, description: "Player RSN", required: true, autocomplete: true },
            { name: "team",    type: 3, description: "Team name",   required: true, autocomplete: true },
          ],
        },

        {
          name: "bingo-setteam",
          description: "Assign an RSN to a team",
          options: [
            { name: "rsn",  type: 3, description: "Player RSN", required: true },
            { name: "team", type: 3, description: "Team name (free text)", required: true },
          ],
        },
        { name: "bingo-teams", description: "Show current RSN → Team assignments" },

        // Admin reseed from repo
        { name: "bingo-reseed", description: "ADMIN: replace /data/bingo.json with repo copy" },
      ],
    });
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

// ---------- COMMAND HANDLERS ----------
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  console.log("[INT]", i.commandName, i.options?.data?.map((o) => `${o.name}=${o.value}`).join(", "));

  // /bingo-setchannel
  if (i.commandName === "bingo-setchannel") {
    try {
      await i.deferReply({ ephemeral: true });
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

  // /bingo-password
  else if (i.commandName === "bingo-password") {
    try {
      await i.deferReply({ ephemeral: true });
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

  // /bingo-board
  else if (i.commandName === "bingo-board") {
    try {
      await i.deferReply({ ephemeral: true });
      const team = i.options.getString("team")?.trim();
      if (!team) return i.editReply("Team is required.");
      const buf = await renderBoardBuffer(team);
      await i.editReply({
        content: `Current Bingo Board — **${team}**`,
        files: [{ attachment: buf, name: `bingo_${team.replace(/\s+/g, "_")}.png` }],
      });
    } catch (err) {
      console.error("Error in /bingo-board:", err);
      if (!i.replied) try { await i.editReply("Error generating board image."); } catch {}
    }
  }

  // /bingo-add
  else if (i.commandName === "bingo-add") {
    try {
      await i.deferReply({ ephemeral: true });
      const team = i.options.getString("team")?.trim();
      const rsn  = i.options.getString("rsn")?.trim();
      const item = i.options.getString("item")?.trim();
      if (!team || !rsn || !item) return i.editReply("Missing team/rsn/item.");

      ensureTeamBucket(team);
      const before = JSON.stringify(data.completedByTeam?.[team] || {});
      await processParsedDrop(rsn, team, item);
      const after  = JSON.stringify(data.completedByTeam?.[team] || {});
      if (before === after) {
        return i.editReply(`No matching tile for **${item}** on **${team}**. Check item spelling or tile regex.`);
      }
      return i.editReply(`Recorded **${item}** for **${rsn}** on **${team}**.`);
    } catch (err) {
      console.error("Error in /bingo-add:", err);
      if (!i.replied) try { await i.editReply("Error adding drop. Check logs."); } catch {}
    }
  }

  // /bingo-mark (tolerant tilekey)
  else if (i.commandName === "bingo-mark") {
    try {
      await i.deferReply({ ephemeral: true });
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
        return i.editReply("Need Manage Server permission.");

      const keyRaw = i.options.getString("tilekey");
      const keyNorm = normalizeKey(keyRaw);
      const rsn = i.options.getString("rsn");
      const team = i.options.getString("team");

      const tile = data.tiles.find((t) => normalizeKey(t.key) === keyNorm);
      if (!tile) {
        const known = (data.tiles || []).map((t) => t.key).join(", ");
        return i.editReply(`Unknown tile key: \`${keyRaw}\`.\nKnown keys: ${known}`);
      }

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

      return i.editReply(`Marked \`${tile.key}\` complete for **${team}**.`);
    } catch (err) {
      console.error("Error in /bingo-mark:", err);
      if (!i.replied) try { await i.editReply("Something went wrong running /bingo-mark."); } catch {}
    }
  }

  // /bingo-setteam
  else if (i.commandName === "bingo-setteam") {
    try {
      await i.deferReply({ ephemeral: true });
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
        return i.editReply("Need Manage Server permission.");

      const rsn = i.options.getString("rsn")?.trim();
      const team = i.options.getString("team")?.trim();
      if (!rsn || !team) return i.editReply("Both RSN and Team are required.");

      data.rsnToTeam[rsn] = team;
      saveData(data);
      return i.editReply(`Assigned **${rsn}** to **${team}**.`);
    } catch (err) {
      console.error("Error in /bingo-setteam:", err);
      if (!i.replied) try { await i.editReply("Error setting team."); } catch {}
    }
  }

  // /bingo-teams
  else if (i.commandName === "bingo-teams") {
    try {
      await i.deferReply({ ephemeral: true });
      const entries = Object.entries(data.rsnToTeam || {});
      if (!entries.length) return i.editReply("No RSN → Team assignments yet.");
      const byTeam = entries.reduce((acc, [rsn, team]) => {
        acc[team] = acc[team] || [];
        acc[team].push(rsn);
        return acc;
      }, {});
      const lines = Object.keys(byTeam)
        .sort()
        .map((team) => `**${team}**: ${byTeam[team].join(", ")}`);
      return i.editReply(lines.join("\n"));
    } catch (err) {
      console.error("Error in /bingo-teams:", err);
      if (!i.replied) try { await i.editReply("Error listing teams."); } catch {}
    }
  }

  // /bingo-reseed
  else if (i.commandName === "bingo-reseed") {
    try {
      await i.deferReply({ ephemeral: true });
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
        return i.editReply("Need Manage Server permission.");
      if (!fs.existsSync(REPO_DEFAULT_PATH)) return i.editReply("Repo bingo.json not found.");
      const src = JSON.parse(fs.readFileSync(REPO_DEFAULT_PATH, "utf8"));
      fs.writeFileSync(DATA_PATH, JSON.stringify(src, null, 2));
      data = loadData();
      return i.editReply(
        `Reseeded data from repo. Tiles=${(data.tiles || []).length}, RSNs=${Object.keys(
          data.rsnToTeam || {}
        ).length}`
      );
    } catch (err) {
      console.error("Error in /bingo-reseed:", err);
      if (!i.replied) try { await i.editReply("Error reseeding."); } catch {}
    }
  }
});

// --- Health check ---
app.get("/", (_req, res) => res.send("OK"));

// --- Optional HMAC verify ---
function verifySignature(rawBody, signature) {
  if (!BINGO_WEBHOOK_SECRET) return true;
  try {
    const hmac = crypto.createHmac("sha256", BINGO_WEBHOOK_SECRET).update(rawBody).digest("hex");
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

// --- Dink / webhook parsing in #bingo-drops ---
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

const CELEB = ["🎉", "🏆", "💎", "🔥", "🍀", "🎯", "✨"];

async function processParsedDrop(rsn, team, itemName) {
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
    const bucket = data.completedByTeam[team];
    const c = bucket[tile.key];

    // Always announce the drop
    await bingoChannel?.send(`${CELEB[Math.floor(Math.random() * CELEB.length)]} **${rsn}** (${team}) got **${itemName}**`);

    if (!justCompleted) {
      if (tile.type === "anyCount") {
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — ${c.progress.total}/${tile.count}`);
      } else if (tile.type === "orCount") {
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — ${c.progress.total}/${tile.count} (or ALT)`);
      } else if (tile.type === "setAll") {
        const have = Object.keys(c.sets.collected || {}).length;
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — ${have}/${tile.set.length}`);
      } else if (tile.type === "orSetAll") {
        const counts = tile.sets.map((setArr, idx) => {
          const got = Object.keys((c.sets && c.sets[idx]) || {}).length;
          return { got, total: setArr.length };
        });
        counts.sort((a, b) => b.got - a.got);
        const best = counts[0] || { got: 0, total: tile.sets[0]?.length || 4 };
        await bingoChannel?.send(`Progress (**${team}**): **${tile.name}** — best set ${best.got}/${best.total}`);
      }
      saveData(data);
      continue;
    }

    saveData(data);
    const embed = new EmbedBuilder()
      .setTitle("Bingo Tile Completed!")
      .setDescription(`${CELEB[Math.floor(Math.random() * CELEB.length)]} **${rsn}** completed **${tile.name}** for **${team}**`)
      .addFields({ name: "Tile Key", value: tile.key, inline: true })
      .setFooter({ text: "OSRS Bingo" });

    await bingoChannel?.send({ embeds: [embed] });
    await postBoardImage(bingoChannel, team);
  }

  if (!hitAny) {
    await bingoChannel?.send(
      `No tile matched **${itemName}** for **${team}**. (If this should match, tweak the tile regex in \`bingo.json\`.)`
    );
  }
}

// --- Start HTTP + Discord ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listening on ${PORT}`));
client.login(DISCORD_TOKEN);

// Crash guards
process.on("unhandledRejection", (r) => console.error("[UNHANDLED REJECTION]", r));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT EXCEPTION]", e));
process.on("SIGTERM", () => console.log("[SHUTDOWN] SIGTERM received"));
process.on("SIGINT", () => console.log("[SHUTDOWN] SIGINT received"));
