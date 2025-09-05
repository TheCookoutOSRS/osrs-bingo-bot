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
          rsnToTeam: {},   // { "RSN": "Team A" }
          tiles: [],       // populated by your bingo.json
          completed: {},   // { tileKey: { done: true, by: {...}, progress: {...} } }
          channelId: ""
        },
        null, 2
      )
    );
  }
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}
function saveData(d) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
}
let data = loadData();

// --- Helpers ---
const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Match an itemName against one tile's rules
function matchTile(tile, itemName) {
  const n = norm(itemName);

  if (tile.type === "single") {
    return tile.matches.some(rx => new RegExp(rx, "i").test(itemName));
  }

  if (tile.type === "anyCount") {
    // “Get N of any from this list (duplicates allowed)”
    return tile.sources.some(rx => new RegExp(rx, "i").test(itemName));
  }

  if (tile.type === "setAll") {
    // We only return true if this specific drop is part of the set
    return tile.set.some(rx => new RegExp(rx, "i").test(itemName));
  }

  if (tile.type === "orSetAll") {
    // This drop belongs to either setA or setB
    return tile.sets.flat().some(rx => new RegExp(rx, "i").test(itemName));
  }

  if (tile.type === "orCount") {
    // Either count X of sources[0] OR any of alternativeMatches
    const inCountGroup = tile.sources.some(rx => new RegExp(rx, "i").test(itemName));
    const inAlt = (tile.alternativeMatches || []).some(rx => new RegExp(rx, "i").test(itemName));
    return inCountGroup || inAlt;
  }

  if (tile.type === "pet") {
    // pet is always manual tonight (use /bingo-mark), but keep stub
    return false;
  }

  return false;
}

function ensureTileProgress(tile) {
  if (!data.completed[tile.key]) {
    data.completed[tile.key] = { done: false, by: null, progress: { total: 0, perTeam: {} }, sets: {} };
  }
  return data.completed[tile.key];
}

function handleProgress(tile, team, rsn, itemName) {
  const entry = ensureTileProgress(tile);
  if (entry.done) return false;

  if (tile.type === "single") {
    entry.done = true;
    entry.by = { team, rsn, itemName, ts: Date.now() };
    return true;
  }

  if (tile.type === "anyCount") {
    // Need N total from tile.sources
    entry.progress.total = (entry.progress.total || 0) + 1;
    entry.progress.perTeam[team] = (entry.progress.perTeam[team] || 0) + 1;
    if (entry.progress.total >= tile.count) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now() };
      return true;
    }
    return false;
  }

  if (tile.type === "setAll") {
    // must collect all regexes from tile.set (unique members)
    if (!entry.sets.collected) entry.sets.collected = {};
    const matched = tile.set.find(rx => new RegExp(rx, "i").test(itemName));
    if (matched) entry.sets.collected[matched] = true;

    const allDone = tile.set.every(rx => entry.sets.collected[rx]);
    if (allDone) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now() };
      return true;
    }
    return false;
  }

  if (tile.type === "orSetAll") {
    // either entire sets[0] or sets[1]
    if (!entry.sets.A) entry.sets.A = {};
    if (!entry.sets.B) entry.sets.B = {};

    const hitA = tile.sets[0].find(rx => new RegExp(rx, "i").test(itemName));
    const hitB = tile.sets[1].find(rx => new RegExp(rx, "i").test(itemName));
    if (hitA) entry.sets.A[hitA] = true;
    if (hitB) entry.sets.B[hitB] = true;

    const aDone = tile.sets[0].every(rx => entry.sets.A[rx]);
    const bDone = tile.sets[1].every(rx => entry.sets.B[rx]);

    if (aDone || bDone) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now() };
      entry.sets.completed = aDone ? "A" : "B";
      return true;
    }
    return false;
  }

  if (tile.type === "orCount") {
    // Option 1: get 'count' of sources; Option 2: get any of alternativeMatches
    const inCountGroup = tile.sources.some(rx => new RegExp(rx, "i").test(itemName));
    const inAlt = (tile.alternativeMatches || []).some(rx => new RegExp(rx, "i").test(itemName));

    if (inAlt) {
      entry.done = true;
      entry.by = { team, rsn, itemName, ts: Date.now(), alt: true };
      return true;
    }

    if (inCountGroup) {
      entry.progress.total = (entry.progress.total || 0) + 1;
      entry.progress.perTeam[team] = (entry.progress.perTeam[team] || 0) + 1;
      if (entry.progress.total >= tile.count) {
        entry.done = true;
        entry.by = { team, rsn, itemName, ts: Date.now() };
        return true;
      }
      return false;
    }
  }

  if (tile.type === "pet") {
    // manual: handled by /bingo-mark
    return false;
  }

  return false;
}

function findTeamByRSN(rsn) {
  return data.rsnToTeam?.[rsn] || "Unassigned";
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
            options: [
              { name: "channel", type: 7, description: "Target channel", required: true },
            ],
          },
          { name: "bingo-password", description: "Reveal the bingo password (and start time)" },
          {
            name: "bingo-status",
            description: "Show completion summary for all tiles"
          },
          {
            name: "bingo-mark",
            description: "Manually mark a tile complete (e.g., PET/edge cases)",
            options: [
              { name: "tilekey", type: 3, description: "Tile key", required: true },
              { name: "rsn", type: 3, description: "Player RSN", required: true },
              { name: "team", type: 3, description: "Team name", required: true }
            ]
          },
          {
            name: "bingo-setteam",
            description: "Assign an RSN to a team",
            options: [
        { name: "rsn", type: 3, description: "Player RSN", required: true },
        { name: "team", type: 3, description: "Team name (free text)", required: true }
  ]
          },
          {
          name: "bingo-teams",
          description: "Show current RSN → Team assignments"
        },

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
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
      return i.reply({ content: "Need Manage Server permission.", ephemeral: true });
    const ch = i.options.getChannel("channel");
    bingoChannel = ch;
    data.channelId = ch.id;
    saveData(data);
    return i.reply(`Bingo drops channel set to ${ch}`);
  }
  if (i.commandName === "bingo-setteam") {
  if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return i.reply({ content: "Need Manage Server permission.", ephemeral: true });
  }
  const rsn = i.options.getString("rsn").trim();
  const team = i.options.getString("team").trim();
  if (!rsn || !team) {
    return i.reply({ content: "Both RSN and Team are required.", ephemeral: true });
  }
  data.rsnToTeam[rsn] = team;   // any custom team name is fine
  saveData(data);
  return i.reply({ content: `Assigned **${rsn}** to **${team}**.`, ephemeral: true });
}

if (i.commandName === "bingo-teams") {
  const entries = Object.entries(data.rsnToTeam || {});
  if (!entries.length) {
    return i.reply({ content: "No RSN → Team assignments yet.", ephemeral: true });
  }
  // Group by team for readability
  const byTeam = entries.reduce((acc, [rsn, team]) => {
    acc[team] = acc[team] || [];
    acc[team].push(rsn);
    return acc;
  }, {});
  const lines = Object.keys(byTeam).sort().map(team => `**${team}**: ${byTeam[team].join(", ")}`);
  return i.reply({ content: lines.join("\n"), ephemeral: true });
}

  if (i.commandName === "bingo-password") {
    return i.reply(
      `The bingo password is: **${PASSWORD}** (active starting <t:${Math.floor(
        START_TIME.getTime() / 1000
      )}:F>)`
    );
  }

  if (i.commandName === "bingo-status") {
    const total = data.tiles.length;
    const done = Object.values(data.completed).filter(x => x.done).length;
    const lines = data.tiles.map(t => {
      const c = data.completed[t.key];
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
          const A = Object.keys(c?.sets?.A || {}).length;
          const B = Object.keys(c?.sets?.B || {}).length;
          return `• ${t.key}: ${t.name} — A:${A}/${t.sets[0].length} or B:${B}/${t.sets[1].length}`;
        }
        return `• ${t.key}: ${t.name} — not complete`;
      }
      return `• ✅ ${t.key}: ${t.name} — by ${c.by?.rsn} (${c.by?.team})`;
    }).slice(0, 25); // keep it short
    return i.reply({ content: `Progress: ${done}/${total}\n` + lines.join("\n"), ephemeral: true });
  }

  if (i.commandName === "bingo-mark") {
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
      return i.reply({ content: "Need Manage Server permission.", ephemeral: true });
    const key = i.options.getString("tilekey");
    const rsn = i.options.getString("rsn");
    const team = i.options.getString("team");
    const tile = data.tiles.find(t => t.key === key);
    if (!tile) return i.reply({ content: "Unknown tile key.", ephemeral: true });

    const e = ensureTileProgress(tile);
    e.done = true;
    e.by = { team, rsn, itemName: "(manual)", ts: Date.now() };
    saveData(data);

    if (bingoChannel) {
      const embed = new EmbedBuilder()
        .setTitle("Bingo Tile Completed! (Manual)")
        .setDescription(`**${rsn}** (${team}) completed **${tile.name}**`)
        .setFooter({ text: "OSRS Bingo" });
      await bingoChannel.send({ embeds: [embed] });
    }
    return i.reply({ content: `Marked ${key} complete.`, ephemeral: true });
  }

  if (i.commandName === "bingo-setteam") {
  if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return i.reply({ content: "Need Manage Server permission.", ephemeral: true });
  }
  const rsn = i.options.getString("rsn").trim();
  const team = i.options.getString("team").trim();
  if (!rsn || !team) {
    return i.reply({ content: "Both RSN and Team are required.", ephemeral: true });
  }
  data.rsnToTeam[rsn] = team;   // any custom team name is fine
  saveData(data);
  return i.reply({ content: `Assigned **${rsn}** to **${team}**.`, ephemeral: true });
}

if (i.commandName === "bingo-teams") {
  const entries = Object.entries(data.rsnToTeam || {});
  if (!entries.length) {
    return i.reply({ content: "No RSN → Team assignments yet.", ephemeral: true });
  }
  // Group by team for readability
  const byTeam = entries.reduce((acc, [rsn, team]) => {
    acc[team] = acc[team] || [];
    acc[team].push(rsn);
    return acc;
  }, {});
  const lines = Object.keys(byTeam).sort().map(team => `**${team}**: ${byTeam[team].join(", ")}`);
  return i.reply({ content: lines.join("\n"), ephemeral: true });
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

// --- /drops (for future plugin) ---
app.post("/drops", (req, res) => {
  const now = new Date();
  if (now < START_TIME) return res.status(403).json({ error: "Bingo not started yet." });

  const sig = req.headers["x-bingo-signature"];
  const rawBody = JSON.stringify(req.body || {});
  if (!verifySignature(rawBody, sig)) return res.status(401).json({ error: "Bad signature" });

  const { password, itemName, itemId, player } = req.body || {};
  if (password !== PASSWORD) return res.status(403).json({ error: "Invalid password." });
  if (!bingoChannel) return res.status(400).json({ error: "No bingo channel set." });
  if (!itemName || !player) return res.status(400).json({ error: "Missing itemName/player" });

  // Minimal: treat like a parsed message (team lookup + tile match)
  const team = findTeamByRSN(player);
  processParsedDrop(player, team, itemName);
  return res.json({ ok: true });
});

// --- Message parser for Dink/Loot Logger webhook posts ---
client.on("messageCreate", async (msg) => {
  if (!bingoChannel || msg.channel.id !== bingoChannel.id) return;
  if (!msg.author.bot) return;

  // Prefer text content; fall back to embed description/title if needed
  let text = msg.content || "";
  if (!text && msg.embeds?.length) {
    const e = msg.embeds[0];
    text = e?.description || e?.title || "";
  }
  if (!text) return;

  // Try a couple simple formats:
  //  "🎉 Drop logged by Player: Abyssal Whip (ID: 4151)"
  //  "Player received Abyssal Whip (ID: 4151)"
  let m =
    text.match(/by\s+\**(.+?)\**.*?:\s+\**(.+?)\**.*?\(ID:\s*(\d+)\)/i) ||
    text.match(/^\**?(.+?)\**?.*?received\s+\**(.+?)\**?.*?\(ID[:#]?\s*(\d+)\)/i) ||
    text.match(/^\**?(.+?)\**?:\s+\**(.+?)\**/i); // fallback: "Player: Item"

  if (!m) return;
  const [, player, itemName] = m;
  const team = findTeamByRSN(player);

  await processParsedDrop(player, team, itemName);
});

async function processParsedDrop(rsn, team, itemName) {
  // Try to match tiles
  for (const tile of data.tiles) {
    if (tile.inactive) continue;
    if (!matchTile(tile, itemName)) continue;

    const justCompleted = handleProgress(tile, team, rsn, itemName);
    if (!justCompleted) {
      // For counters, echo progress
      const c = data.completed[tile.key];
      if (tile.type === "anyCount") {
        await bingoChannel?.send(`Progress: **${tile.name}** — ${c.progress.total}/${tile.count}`);
      } else if (tile.type === "orCount") {
        await bingoChannel?.send(`Progress: **${tile.name}** — ${c.progress.total}/${tile.count} (or alt)`);
      } else if (tile.type === "setAll") {
        const have = Object.keys(c.sets.collected || {}).length;
        await bingoChannel?.send(`Progress: **${tile.name}** — ${have}/${tile.set.length}`);
      } else if (tile.type === "orSetAll") {
        const A = Object.keys(c.sets.A || {}).length, B = Object.keys(c.sets.B || {}).length;
        await bingoChannel?.send(`Progress: **${tile.name}** — A:${A}/${tile.setsA_len || 0} or B:${B}/${tile.setsB_len || 0}`);
      }
      saveData(data);
      continue;
    }

    saveData(data);
    const embed = new EmbedBuilder()
      .setTitle("Bingo Tile Completed!")
      .setDescription(`**${rsn}** (${team}) completed **${tile.name}**`)
      .addFields({ name: "Tile Key", value: tile.key, inline: true })
      .setFooter({ text: "OSRS Bingo" });
    await bingoChannel?.send({ embeds: [embed] });
  }
}

// --- Start HTTP + Discord ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listening on ${PORT}`));
client.login(DISCORD_TOKEN);

// Crash guards
process.on("unhandledRejection", (r) => console.error("[UNHANDLED REJECTION]", r));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT EXCEPTION]", e));
