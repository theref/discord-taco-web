const { REST } = require("@discordjs/rest");
const {
  Routes,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord-api-types/v10");
require("dotenv").config();

// Raw JSON command to match partner's structure (taco execute subcommand)
const commands = [
  {
    name: "taco",
    description: "TACo AA signing operations",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: "execute",
        description: "Execute a transfer",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "receiver",
            description: "Discord user to receive the transfer",
            type: ApplicationCommandOptionType.User,
            required: true,
          },
          {
            name: "chain",
            description: "Chain to execute on",
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [{ name: "Base Sepolia", value: "base-sepolia" }],
          },
          {
            name: "token",
            description: "Token to send",
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
              { name: "ETH", value: "ETH" },
              { name: "USDC", value: "USDC" },
            ],
          },
          {
            name: "amount",
            description: "Amount to send (e.g. 0.001)",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "balance",
        description: "Check ETH and USDC balance",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "user",
            description: "User to check balance for (defaults to yourself)",
            type: ApplicationCommandOptionType.User,
            required: false,
          },
        ],
      },
    ],
  },
];

(async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  const isPlaceholder = (v) => /<.*>/.test(v || "");
  const isSnowflake = (v) => /^[0-9]{16,20}$/.test(v || "");

  if (
    !clientId ||
    !guildId ||
    isPlaceholder(clientId) ||
    isPlaceholder(guildId)
  ) {
    throw new Error(
      "Missing or placeholder DISCORD_CLIENT_ID or DISCORD_GUILD_ID. Set real numeric IDs (no angle brackets).",
    );
  }
  if (!isSnowflake(clientId) || !isSnowflake(guildId)) {
    throw new Error(
      "DISCORD_CLIENT_ID or DISCORD_GUILD_ID is not a numeric Discord snowflake.",
    );
  }

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
  console.log(`✓ Deployed /taco to guild ${guildId}`);
})();
