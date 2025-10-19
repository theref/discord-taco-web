const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
require('dotenv').config();

const tip = require('./tip');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
client.commands.set('tip', tip);

client.once(Events.ClientReady, (c) => {
  console.log(`🤖 Discord bot ready as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'tip') {
    return client.commands.get('tip').execute(interaction);
  }
});

client.login(process.env.DISCORD_TOKEN);


