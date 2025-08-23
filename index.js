import express from "express";
app.use(bodyParser.json());


// Environment variables (set in Railway)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PASSWORD = process.env.PASSWORD || "Fall Cookout 25";
const START_TIME = new Date(process.env.START_TIME || "2025-09-05T07:00:00Z");


let bingoChannel = null;


// Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });


client.once("ready", () => {
console.log(`Logged in as ${client.user.tag}`);
});


// Slash command registration
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
try {
await rest.put(Routes.applicationGuildCommands(client.user?.id || "me", GUILD_ID), {
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
description: "Reveal the bingo password",
},
],
});
} catch (err) {
console.error(err);
}
})();


client.on("interactionCreate", async (interaction) => {
if (!interaction.isChatInputCommand()) return;


if (interaction.commandName === "bingo-setchannel") {
bingoChannel = interaction.options.getChannel("channel");
await interaction.reply(`Bingo drops channel set to ${bingoChannel}`);
}


if (interaction.commandName === "bingo-password") {
await interaction.reply(
`The bingo password is: **${PASSWORD}** (active starting <t:${Math.floor(
START_TIME.getTime() / 1000
)}:F>)`
);
}
});


// Drop submission endpoint
app.post("/drops", (req, res) => {
const now = new Date();


if (now < START_TIME)
return res.status(403).json({ error: "Bingo not started yet." });


const { password, itemName, itemId, player } = req.body;


if (password !== PASSWORD)
return res.status(403).json({ error: "Invalid password." });


if (!bingoChannel)
return res.status(400).json({ error: "No bingo channel set." });


bingoChannel.send(
`🎉 **Drop logged** by ${player}: ${itemName} (ID: ${itemId})`
);


res.json({ ok: true });
});


// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));


client.login(DISCORD_TOKEN);