const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('tip')
    .setDescription('Trigger the TACo AA signing demo transfer')
    .toJSON(),
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!clientId || !guildId) {
    throw new Error('DISCORD_CLIENT_ID or DISCORD_GUILD_ID not set');
  }

  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands },
  );
  console.log(`✓ Deployed /tip to guild ${guildId}`);
})();


