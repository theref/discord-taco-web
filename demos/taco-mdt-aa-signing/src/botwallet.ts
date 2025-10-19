// Lightweight helper to compute the Collab.Land bot smart account address via Account Kit SDK
// Note: Uses require() because the SDK ships a default export class

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AccountKitSDK = require('@collabland/accountkit-sdk');
const AccountKit = AccountKitSDK.default;

export async function getBotSmartAccountAddress(): Promise<string | null> {
  const apiKey = process.env.COLLABLAND_ACCOUNTKIT_API_KEY;
  const baseUrl = process.env.ACCOUNT_KIT_BASE_URL || 'https://api-qa.collab.land';
  const botDiscordId = process.env.DISCORD_CLIENT_ID;

  if (!apiKey || !botDiscordId) {
    return null;
  }

  try {
    const client = new AccountKit(apiKey, { baseUrl });
    // Platform workaround common in QA; adjust to 'discord' when supported end-to-end
    const platform = 'github';
    const resp = await client.v2.calculateAccountAddress(platform, botDiscordId);
    const addr = resp?.data?.evm?.[0]?.address as string | undefined;
    return addr ?? null;
  } catch {
    return null;
  }
}


