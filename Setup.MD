## How to Run Locally (TACo team)

**Prereqs**
- Node.js 20.x (LTS)
- pnpm >= 8
- Base Sepolia RPC and a bundler URL

**Env (example)**
```
# Chain + TACo
CHAIN_ID=84532
SIGNING_CHAIN_ID=84532
TACO_DOMAIN=lynx

# Networks
RPC_URL=https://base-sepolia.example
BUNDLER_URL=https://bundler.example

# Wallet
PRIVATE_KEY=0x...

# Discord
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
DISCORD_PUBLIC_KEY=...

# Demo defaults
TIP_AMOUNT_ETH=0.0001
TIP_RECIPIENT=0x1F14beC65ce67c1f659e95978acC8E8e15216B1b
```

**Install and build**
```
# from repo root
pnpm install
pnpm -w build
```

**Deploy the slash command**
```
cd demos/taco-mdt-aa-signing
pnpm run bot:deploy
```

**Run the interactions server + bot**
```
# IMPORTANT: do not export preserve-symlinks for the bot process
NODE_OPTIONS= pnpm run bot:dev
# It will print: 🛰️ Discord interactions server listening on :8787/interactions
```

**Expose interactions endpoint (example)**
```
ngrok http 8787
# Set Discord Interactions Endpoint URL to: https://<random>.ngrok.app/interactions
```

**Use the slash command**
```
/tip amount:0.0001 recipient:0x...
```

**What you should see**
- Ed25519 headers logged; bodyBytes ~ 2KB; overrides printed.
- In the demo process:
  - execute selector 0xb61d27f6 and decoded args with recipient and wei value
  - JSONPath conditions discovered: amount and recipient with expected values
  - callData.decoded.json written to the demo dir

**Artifacts to inspect**
- `demos/taco-mdt-aa-signing/callData.decoded.json` – confirm function and arguments
- Demo logs for `Final context for TACo` and JSONPath results


