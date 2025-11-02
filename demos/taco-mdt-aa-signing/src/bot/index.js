require('dotenv').config();

const { createServer } = require('./interactions');
// Always start the HTTP interactions server (preferred path)
createServer();

if (process.env.ENABLE_GATEWAY_TIP === 'true') {
  const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
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
} else {
  console.log('ℹ️  Gateway /tip handler disabled; use HTTP Interactions endpoint.');
}


