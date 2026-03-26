import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';

// --- Load environment variables ---
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  PORT = 3000,
  ROBLOX_API_KEY,
  PUBLIC_BASE_URL
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !ROBLOX_API_KEY || !PUBLIC_BASE_URL) {
  console.error('Missing environment variables in .env');
  process.exit(1);
}

// --- Express setup ---
const app = express();
app.use(express.json());

// --- Data file handling ---
const DATA_FILE = path.resolve('./data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { links: {}, pendingCodes: {}, entitlements: {} };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getData() {
  return loadData();
}

function setData(mutator) {
  const data = loadData();
  mutator(data);
  saveData(data);
}

function normalizeBool(v) {
  return v === true;
}

// --- Register slash commands ---
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Link your Roblox account using the code from the game')
      .addStringOption(option =>
        option
          .setName('code')
          .setDescription('The verification code from Roblox')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('boosterstatus')
      .setDescription('Check if your account is linked and booster tool status')
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log('Slash commands registered');
}

// --- Discord bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

async function getBoosterRoleId(guild) {
  await guild.roles.fetch();
  const boosterRole = guild.roles.premiumSubscriberRole;
  return boosterRole?.id ?? null;
}

async function memberHasBooster(member) {
  const boosterRoleId = await getBoosterRoleId(member.guild);
  if (!boosterRoleId) return false;
  return member.roles.cache.has(boosterRoleId);
}

async function recomputeEntitlementForDiscordId(discordId) {
  const guild = await client.guilds.fetch(GUILD_ID);
  let member = null;

  try {
    member = await guild.members.fetch(discordId);
  } catch {
    member = null;
  }

  const data = getData();
  const robloxUserId = data.links[discordId];
  if (!robloxUserId) return;

  const hasBooster = member ? await memberHasBooster(member) : false;

  setData(db => {
    db.entitlements[String(robloxUserId)] = hasBooster;
  });

  console.log(`Entitlement updated: discord=${discordId} roblox=${robloxUserId} booster=${hasBooster}`);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'verify') {
    const code = interaction.options.getString('code', true).trim().toUpperCase();

    const data = getData();
    const robloxUserId = data.pendingCodes[code];

    if (!robloxUserId) {
      await interaction.reply({
        content: 'Code not found or expired. Please generate a new code in the game.',
        ephemeral: true
      });
      return;
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(interaction.user.id);
    const hasBooster = await memberHasBooster(member);

    setData(db => {
      db.links[interaction.user.id] = String(robloxUserId);
      db.entitlements[String(robloxUserId)] = hasBooster;
      delete db.pendingCodes[code];
    });

    await interaction.reply({
      content: `Done. Roblox account linked.\nBooster Tool status: ${hasBooster ? 'ACTIVE' : 'INACTIVE'}`,
      ephemeral: true
    });
  }

  if (interaction.commandName === 'boosterstatus') {
    const data = getData();
    const robloxUserId = data.links[interaction.user.id];

    if (!robloxUserId) {
      await interaction.reply({
        content: 'Roblox account not linked yet. Join the game and get a code.',
        ephemeral: true
      });
      return;
    }

    const active = normalizeBool(data.entitlements[String(robloxUserId)]);
    await interaction.reply({
      content: `Linked Roblox UserId: ${robloxUserId}\nBooster Tool: ${active ? 'ACTIVE' : 'INACTIVE'}`,
      ephemeral: true
    });
  }
});

client.on('guildMemberUpdate', async (_oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;
  await recomputeEntitlementForDiscordId(newMember.id);
});

client.on('guildMemberRemove', async member => {
  if (member.guild.id !== GUILD_ID) return;
  await recomputeEntitlementForDiscordId(member.id);
});

// --- Roblox API endpoints ---
app.get('/roblox/create-link-code', (req, res) => {
  const userId = String(req.query.userId || '');
  const key = String(req.query.key || '');

  if (key !== ROBLOX_API_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (!/^\d+$/.test(userId)) {
    return res.status(400).json({ error: 'invalid userId' });
  }

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  setData(db => {
    db.pendingCodes[code] = userId;
  });

  res.json({ code });
});

app.get('/roblox/entitlement', (req, res) => {
  const userId = String(req.query.userId || '');
  const key = String(req.query.key || '');

  if (key !== ROBLOX_API_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const data = getData();
  const active = normalizeBool(data.entitlements[userId]);

  res.json({
    userId,
    hasBoosterTool: active
  });
});

app.get('/', (_req, res) => {
  res.send('OK');
});

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
  console.log(`PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);
});

client.login(DISCORD_TOKEN);