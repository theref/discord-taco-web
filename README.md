# TACo AA Signing Demo

A demo showing TACo distributed signing with Account Abstraction (MetaMask Delegation Toolkit) and Discord integration.

## Overview

This demo demonstrates:
- TACo distributed key signing for Account Abstraction UserOperations
- MetaMask Delegation Toolkit smart accounts with threshold multisig
- Discord `/tip` slash command that triggers on-chain transfers
- Deterministic AA address derivation from Discord user IDs

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Copy `.env.example` to `.env` and fill in the required values.

3. Deploy the Discord slash command:
```bash
pnpm bot:deploy
```

4. Start the Discord interactions server:
```bash
pnpm bot:dev
```

## Environment Variables

See `.env.example` for the full list. Key variables:

- `PRIVATE_KEY` - EOA private key for funding
- `ETH_RPC_URL` - Ethereum Sepolia RPC (L1 for SigningCoordinator)
- `SIGNING_CHAIN_RPC_URL` - Base Sepolia RPC (L2 signing chain)
- `BUNDLER_URL` - Bundler/Paymaster URL
- `DISCORD_*` - Discord bot configuration
- `TACO_DOMAIN` - TACo domain (e.g., `DEVNET`)
- `COHORT_ID` - TACo cohort ID

## Scripts

- `pnpm start` - Run the signing demo directly
- `pnpm bot:dev` - Start Discord interactions server
- `pnpm bot:deploy` - Deploy `/tip` command to Discord

## Architecture

```
src/
  index.ts          - Main demo: AA creation, UserOp signing, execution
  taco-account.ts   - Viem account adapter for TACo cohort
  bot/
    index.js        - Discord bot entry point
    interactions.js - HTTP webhook handler for Discord
    deploy-commands.js - Slash command deployment
```
