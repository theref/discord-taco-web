# TACo AA Signing Demo

A trust-minimized system for executing on-chain transactions from Discord commands using **TACo** (Threshold Access Control) distributed signing and **Account Abstraction** (ERC-4337).

## What This Project Does

This demo enables Discord users to send cryptocurrency to each other using the `/tip` slash command. Under the hood, it:

- **Derives deterministic blockchain wallets** from Discord user IDs (no registration needed)
- **Signs transactions via TACo** - a distributed threshold signing network (M-of-N signers)
- **Executes on-chain** via ERC-4337 Account Abstraction with paymaster support
- **Verifies authorization cryptographically** - the Discord bot is untrusted; TACo enforces all security rules

The key innovation: **the bot cannot cheat**. All authorization (who can send, how much, to whom) is verified cryptographically by TACo nodes before any transaction is signed.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              /tip @user 0.1 ETH                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Discord Platform                                │
│                     Signs interaction with Ed25519 key                       │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Discord Bot (Untrusted)                            │
│                                                                              │
│  1. Validates Discord's Ed25519 signature                                    │
│  2. Derives sender & recipient AA addresses from Discord IDs                 │
│  3. Builds ERC-4337 UserOperation for the transfer                           │
│  4. Forwards to TACo with three context parameters:                          │
│     • CONTEXT_TIMESTAMP - Discord interaction timestamp                      │
│     • CONTEXT_SIGNATURE_HEX - Discord's Ed25519 signature                    │
│     • CONTEXT_DISCORD_PAYLOAD - Full interaction JSON                        │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        TACo Cohort (M-of-N Signers)                          │
│                                                                              │
│  Verifies conditions.json rules:                                             │
│  ✓ Discord signature is valid (Ed25519)                                      │
│  ✓ Sender AA derived from Discord user ID matches UserOp sender              │
│  ✓ Amount > 0 and matches UserOp calldata                                    │
│  ✓ Recipient AA derived correctly from Discord ID                            │
│  ✓ UserOp calldata matches expected transfer                                 │
│                                                                              │
│  If all conditions pass → each node returns its signature share              │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          ERC-4337 Bundler                                    │
│                                                                              │
│  • Submits UserOp to EntryPoint contract                                     │
│  • Paymaster sponsors gas (optional)                                         │
│  • Transaction executes: sender AA → recipient AA                            │
│  • Returns tx hash to user via Discord follow-up                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Trust Model

| Component | Trusted? | Why |
|-----------|----------|-----|
| Discord | Yes | Authenticates users, signs interactions |
| Discord Bot | **No** | Just a relay - cannot forge or modify requests |
| TACo Cohort | Yes (M-of-N) | Cryptographically enforces conditions |
| Bundler | No | Signature is valid regardless of bundler choice |

---

## Deterministic Address Derivation

Every Discord user gets a unique, deterministic blockchain address:

```
salt = keccak256("{discordUserId}|Discord|Collab.Land")
address = SimpleFactory.computeAddress(bytecodeHash, salt)
```

This means:
- No on-chain registration required
- Same Discord user always gets the same address
- Address can be computed off-chain before the account is deployed

---

## Project Structure

```
discord-taco-web/
├── src/
│   ├── index.ts              # Main demo: AA creation, UserOp signing, execution
│   ├── taco-account.ts       # Viem account adapter for TACo cohort
│   └── bot/
│       ├── index.js          # Discord bot entry point (webhook server)
│       ├── interactions.js   # HTTP webhook handler for Discord interactions
│       └── deploy-commands.js # Slash command registration
│
├── scripts/
│   ├── compute-bytecode-hash.ts   # Compute bytecodeHash for conditions.json
│   ├── validate-conditions.ts     # Validate conditions.json syntax
│   └── validate-aa-derivation.ts  # Debug address derivation
│
├── conditions.json           # TACo authorization rules
├── package.json
├── tsconfig.json
│
├── voting.md                 # Design: Discord governance with Snapshot
├── quest.md                  # Design: Competition/leaderboard system
└── prediction.md             # Design: Prediction markets
```

---

## Main Source Files

### `src/index.ts` - Main Demo

The core signing and execution flow:

- **`createTacoSmartAccount()`** - Creates a MetaMask Delegation Toolkit smart account backed by TACo threshold signatures
- **`deriveDiscordUserAA()`** - Derives deterministic AA address from Discord user ID
- **`signUserOpWithTaco()`** - Sends UserOp to TACo cohort for threshold signing with condition verification
- **`main()`** - Orchestrates the full flow: initialize TACo, derive addresses, prepare UserOp, fund if needed, sign via TACo, submit to bundler

### `src/taco-account.ts` - Viem Account Adapter

Adapts TACo cohort signing to work with Viem's account interface. Creates a Viem `Account` object that delegates signing to the TACo cohort, enabling seamless integration with the MetaMask Delegation Toolkit.

### `src/bot/index.js` - Bot Entry Point

Simple HTTP server that loads environment variables, listens for Discord webhook interactions, and routes to the interaction handler.

### `src/bot/interactions.js` - Interaction Handler

Handles incoming Discord slash commands:

1. **Signature Verification** - Validates Discord's Ed25519 signature using `tweetnacl`
2. **UserOp Building** - Derives addresses and builds the ERC-4337 UserOperation
3. **Process Spawning** - Runs `pnpm start` with the three context environment variables
4. **Follow-up Messages** - Sends transaction result back to Discord via webhook API
5. **Concurrency Control** - Prevents multiple simultaneous tip executions

### `src/bot/deploy-commands.js` - Command Registration

Registers the `/tip` slash command with Discord:

```
/tip <amount> <recipient> <token>

Parameters:
  amount:    Number (e.g., 0.01)
  recipient: Discord User (@mention)
  token:     Choice (ETH or USDC)
```

Run once during setup with `pnpm bot:deploy`.

---

## Scripts

### `scripts/compute-bytecode-hash.ts`

**Purpose:** Compute the `bytecodeHash` needed for `conditions.json` and address derivation.

**When to use:**
- Initial setup when configuring a new TACo cohort
- When cohort signers or threshold changes
- Before updating `conditions.json`

**What it does:**
1. Fetches cohort configuration from L1 SigningCoordinator
2. Computes `keccak256(proxyCreationCode)` for the smart account bytecode
3. Outputs values needed for configuration

```bash
npx tsx scripts/compute-bytecode-hash.ts
```

### `scripts/validate-conditions.ts`

**Purpose:** Validate `conditions.json` syntax before deployment.

**When to use:**
- After modifying `conditions.json`
- Before deploying the application
- To debug condition expression errors

**What it does:**
1. Loads and parses `conditions.json`
2. Validates against TACo SDK schemas
3. Reports success or writes detailed errors to `validation-error.txt`

```bash
npx tsx scripts/validate-conditions.ts
```

### `scripts/validate-aa-derivation.ts`

**Purpose:** Debug address derivation mismatches.

**When to use:**
- When computed addresses don't match expected values
- To verify cohort configuration is correct
- QA/testing of the derivation logic

**What it does:**
1. Takes a Discord user ID as argument
2. Computes salt and calls `SimpleFactory.computeAddress()` on-chain
3. Compares against local computation
4. Reports match/mismatch with diagnostics

```bash
npx tsx scripts/validate-aa-derivation.ts 123456789012345678
```

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

### Blockchain RPC
| Variable | Description |
|----------|-------------|
| `ETH_RPC_URL` | Ethereum Sepolia RPC (L1 for TACo SigningCoordinator) |
| `SIGNING_CHAIN_RPC_URL` | Base Sepolia RPC (L2 where transactions execute) |

### Bundler / Paymaster
| Variable | Description |
|----------|-------------|
| `BUNDLER_URL` | ERC-4337 bundler endpoint (e.g., Pimlico) |

### Discord
| Variable | Description |
|----------|-------------|
| `DISCORD_PUBLIC_KEY` | Discord application public key (for signature verification) |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application client ID |
| `DISCORD_GUILD_ID` | Discord server ID for slash commands |

### TACo
| Variable | Description |
|----------|-------------|
| `TACO_DOMAIN` | TACo network domain (e.g., `DEVNET`) |
| `COHORT_ID` | TACo cohort identifier |

### Funding
| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | EOA private key for funding smart accounts |
| `MIN_SA_BALANCE_ETH` | Minimum balance before auto-funding |
| `FUNDING_AMOUNT_ETH` | Amount to fund when below minimum |

---

## Setup & Running

### Prerequisites

- Node.js 18+
- pnpm
- Discord application with bot
- TACo cohort access
- Ethereum Sepolia + Base Sepolia RPC endpoints
- ERC-4337 bundler endpoint

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd discord-taco-web

# Install dependencies
pnpm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your values
```

### Discord Bot Setup

1. Create a Discord application at https://discord.com/developers
2. Create a bot and get the token
3. Enable the application commands scope
4. Add the bot to your server with appropriate permissions
5. Copy the public key, token, client ID, and guild ID to `.env`

### Deploy Slash Command

```bash
pnpm bot:deploy
```

This registers `/tip` with Discord (run once).

### Start the Bot

```bash
pnpm bot:dev
```

Starts the webhook server listening for Discord interactions.

### Direct Execution (Testing)

```bash
pnpm start
```

Runs the signing demo directly without Discord. Requires context environment variables to be set manually.

---

## Understanding `conditions.json`

The `conditions.json` file defines the authorization rules that TACo signers enforce. The conditions are structured as a compound `AND` of three main parts:

### 1. Discord Signature Verification

```json
{
  "conditionType": "ecdsa",
  "message": ":timestamp:discordPayload",
  "signature": ":signature",
  "verifyingKey": "<DISCORD_PUBLIC_KEY>",
  "curve": "Ed25519"
}
```

Verifies the Discord interaction is authentically signed.

### 2. Sender Validation (Sequential)

Ensures the UserOp sender matches the Discord user who issued the command:

1. **Extract sender Discord ID** from `$.member.user.id` and derive salt
2. **Compute sender AA address** via on-chain `SimpleFactory.computeAddress()`
3. **Validate UserOp sender** matches the derived address

```json
{
  "varName": "validateSender",
  "condition": {
    "conditionType": "signing-attribute",
    "attributeName": "sender",
    "returnValueTest": { "comparator": "==", "value": ":senderAA" }
  }
}
```

This prevents the bot from submitting a UserOp on behalf of a different user.

### 3. Transfer Validation (Sequential)

Validates the transfer parameters:

1. **Extract amount** from Discord payload, validate > 0, convert to wei
2. **Extract recipient Discord ID** and derive salt
3. **Compute recipient AA address** via on-chain `SimpleFactory.computeAddress()`
4. **Validate UserOp calldata** matches expected transfer:

```json
{
  "varName": "validateCalldata",
  "condition": {
    "conditionType": "signing-abi-attribute",
    "attributeName": "call_data",
    "abiValidation": {
      "allowedAbiCalls": {
        "execute((address,uint256,bytes))": [
          { "parameterIndex": 0, "indexWithinTuple": 0, "returnValueTest": { "comparator": "==", "value": ":recipientAA" } },
          { "parameterIndex": 0, "indexWithinTuple": 1, "returnValueTest": { "comparator": "==", "value": ":amountDiscord" } }
        ]
      }
    }
  }
}
```

This ensures:
- Recipient address matches the derived `:recipientAA`
- Amount matches `:amountDiscord` (in wei)

---

## Future Features

This repository includes design documents for planned extensions:

### [voting.md](./voting.md) - Discord-Native Governance

Integrate with Snapshot for gasless off-chain voting, with TACo-signed on-chain execution:
- `/propose` - Create governance proposals (admin only)
- `/vote` - Sign Snapshot votes via TACo (EIP-1271)
- `/execute` - Execute winning proposals on-chain

TACo verifies: proposal state, quorum, winning choice, execution payload binding.

### [quest.md](./quest.md) - Competition System

Leaderboard/quest system with merkle-proof prize claims:
- `/quest create` - Create tipping competitions
- `/quest claim` - Winners claim prizes via merkle proofs

TACo verifies: merkle proof validity, rank eligibility, no double claims.

### [prediction.md](./prediction.md) - Prediction Markets

Decentralized prediction markets with TACo as oracle:
- `/predict bet` - Place bets on YES/NO outcomes
- `/predict claim` - Claim winnings after resolution

TACo verifies: market resolution via external data sources, proportional payout calculations.

---

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `start` | `tsx src/index.ts` | Run signing demo |
| `dev` | `tsx src/index.ts --debug` | Run with debug output |
| `bot:deploy` | `node src/bot/deploy-commands.js` | Register Discord slash commands |
| `bot:dev` | `node src/bot/index.js` | Start Discord webhook server |

---

## License

GPL-3.0-only
