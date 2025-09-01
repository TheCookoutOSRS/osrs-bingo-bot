// --- Boot logs (helpful on Render) ---
console.log("[BOOT] starting Cookout Bingo Bot...");

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";

// Create express app BEFORE using it
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

let bingoChannel = null;

// --- Discord client ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands after login
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
              {
                name: "channel",
                type: 7, // CHANNEL
                description: "Target channel",
                required: true,
              },
            ],
          },
          {
            name: "bingo-password",
            description: "Reveal the bingo password (and start time)",
          },
        ],
      }
    );
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "bingo-setchannel") {
    const ch = interaction.options.getChannel("channel");
    bingoChannel = ch;
    await interaction.reply(`Bingo drops channel set to ${ch}`);
  }

  if (interaction.commandName === "bingo-password") {
    await interaction.reply(
      `The bingo password is: **${PASSWORD}** (active starting <t:${Math.floor(
        START_TIME.getTime() / 1000
      )}:F>)`
    );
  }
});

// --- Health check (Render) ---
app.get("/", (_req, res) => res.send("OK"));

// --- Optional HMAC verify for /drops ---
function verifySignature(rawBody, signature) {
  if (!BINGO_WEBHOOK_SECRET) return true; // skip if not set
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

// --- Drops endpoint ---
app.post("/drops", (req, res) => {
  const now = new Date();
  if (now < START_TIME) {
    return res.status(403).json({ error: "Bingo not started yet." });
  }

  // If using HMAC, client should send header X-Bingo-Signature
  const sig = req.headers["x-bingo-signature"];
  const rawBody = JSON.stringify(req.body || {});
  if (!verifySignature(rawBody, sig)) {
    return res.status(401).json({ error: "Bad signature" });
  }

  const { password, itemName, itemId, player } = req.body || {};

  if (password !== PASSWORD) {
    return res.status(403).json({ error: "Invalid password." });
  }
  if (!bingoChannel) {
    return res.status(400).json({ error: "No bingo channel set." });
  }
  if (!itemName || !itemId || !player) {
    return res.status(400).json({ error: "Missing itemName/itemId/player" });
  }

  bingoChannel.send(
    `🎉 **Drop logged** by **${player}**: **${itemName}** (ID: ${itemId})`
  );

  return res.json({ ok: true });
});

// --- Start HTTP + Discord ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listening on ${PORT}`));
client.login(DISCORD_TOKEN);

// Crash guards (helpful on Render)
process.on("unhandledRejection", (r) => console.error("[UNHANDLED REJECTION]", r));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT EXCEPTION]", e));
