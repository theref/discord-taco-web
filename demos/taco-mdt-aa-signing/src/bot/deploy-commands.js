const { REST } = require('@discordjs/rest');
const { Routes, ApplicationCommandType, ApplicationCommandOptionType } = require('discord-api-types/v10');
require('dotenv').config();

// Raw JSON command to avoid builders/shapeshift
const commands = [
  {
    name: 'tip',
    description: 'Trigger the TACo AA signing demo transfer',
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: 'amount',
        description: 'Amount in ETH (e.g. 0.0001)',
        type: ApplicationCommandOptionType.Number,
        required: true,
      },
      {
        name: 'recipient',
        description: 'Discord user to receive the tip',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  const isPlaceholder = (v) => /<.*>/.test(v || '');
  const isSnowflake = (v) => /^[0-9]{16,20}$/.test(v || '');

  if (!clientId || !guildId || isPlaceholder(clientId) || isPlaceholder(guildId)) {
    throw new Error('Missing or placeholder DISCORD_CLIENT_ID or DISCORD_GUILD_ID. Set real numeric IDs (no angle brackets).');
  }
  if (!isSnowflake(clientId) || !isSnowflake(guildId)) {
    throw new Error('DISCORD_CLIENT_ID or DISCORD_GUILD_ID is not a numeric Discord snowflake.');
  }

  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands },
  );
  console.log(`✓ Deployed /tip to guild ${guildId}`);
})();
