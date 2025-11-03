# TACo MDT AA Signing – Debug Overview and Runbook

## Current Working Understandings

- **Chains and domain**
  - CHAIN_ID=84532 (Base Sepolia) for execution; SIGNING_CHAIN_ID=84532 for TACo signing requests.
  - TACo SigningCoordinator canonical data is on the parent (Sepolia 11155111); the agent fetches cohort conditions from the parent by design. This is not the cause of node-side rejections.

- **Interactions server**
  - Uses native Node http (no Express), verifies Discord Ed25519 over `${timestamp}${rawBody}` using DISCORD_PUBLIC_KEY.
  - Exports to the demo child:
    - CONTEXT_MESSAGE_HEX: 0x + hex(timestamp||rawBody)
    - CONTEXT_SIGNATURE_HEX: Ed25519 sig (no 0x)
    - CONTEXT_DISCORD_PAYLOAD: raw Discord JSON body (unchanged)
    - TIP_AMOUNT_ETH and TIP_RECIPIENT extracted for convenience
  - Forces JSONPath JS engine in the child process (no WASM).

- **Demo signing flow**
  - Builds AA call offline, then signs with TACo, then sends to bundler (signature included from the start).
  - Encoding: execute(address to,uint256 value,bytes data) with value in wei; callData used for both signing and bundler send.
  - ':message' currently uses the Discord timestamp||body hex (per cohorts that verify Ed25519). Optional lever: switch to canonical ERC-4337 user op hash if TACo confirms it's acceptable for the cohort.

- **Logging and diagnostics**
  - Prints cohort condition bytes and local JSONPath evaluations (queries + results) over `:discordPayload`.
  - Persists `callData.decoded.json` with selector, raw callData, and decode results for multiple ABI candidates.
  - Prints final TACo context keys/sizes for quick sanity.

- **What passes now**
  - JSONPath conditions: amount and recipient are discovered as expected; amount supplied via Discord in ETH (e.g., "0.0001").
  - callData decode: selector 0xb61d27f6 (= execute), args match recipient and value=100000000000000 wei and data=0x.
  - Ed25519 verification (local) is ok=true.

- **What still fails**
  - TACo nodes return "Decryption conditions not satisfied". With JSONPath and callData correct, the most likely remaining mismatch is in the cohort's signing-abi-attribute stage:
    - Cohort may validate a specific execute ABI/signature on the smart account differing from the generic `execute(address,uint256,bytes)`, or a slightly different contract/ABI context (e.g., MDT multisig flavor).
    - Alternatively, the cohort may require ':message' to be the canonical userOp hash rather than Discord timestamp||body; if so, Ed25519-oriented conditions would be disabled in that cohort.

## Suggested Fixes (Prioritized)

1) **Confirm the exact ABI and contract context the cohort validates in signing-abi-attribute**
   - Provide the exact function signature and parameter order. If it's not the generic `execute(address,uint256,bytes)`, update the demo encoding to match and keep bundler send callData identical.

2) **Confirm ':message' expectation for the cohort**
   - If the cohort requires Discord Ed25519, keep ':message' as timestamp||body and signature as Ed25519.
   - If not required, switch ':message' to canonical userOp hash and retry (optional lever already implemented as a simple toggle candidate).

3) **Maintain units and payload format**
   - Discord 'amount' is ETH in the payload; the demo parses to wei for callData. This matches common cohort pipelines that multiply ETH by 1e18 internally before comparing to callData.value.

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

## Where to Change Things Quickly

- **Interactions server**: `demos/taco-mdt-aa-signing/src/bot/interactions.js`
  - Ed25519 verification, raw Discord body pass-through.

- **Demo core**: `demos/taco-mdt-aa-signing/src/index.ts`
  - Direct ABI encoding for `execute(address,uint256,bytes)` (value in wei)
  - Optional lever to switch ':message' to canonical userOp hash (easy to flip if needed)
  - JSONPath local evaluation debug logs
  - Persistent `callData.decoded.json`

- **Slash command**: `demos/taco-mdt-aa-signing/src/bot/deploy-commands.js`
  - amount is a Number (ETH) and recipient is a String

## Open Questions for TACo

- Which exact contract + function signature does the cohort’s signing-abi-attribute decode for value/recipient?
  - If it’s not `execute(address,uint256,bytes)` on the account, please share the ABI so we can encode that directly.
- Does this cohort require ':message' to be Discord timestamp||body (with Ed25519), or can ':message' be the canonical userOp hash?

## Conclusion
- Context (JSONPath + Ed25519) and callData (execute with wei) are aligned locally.
- Node-side failures likely stem from a precise ABI/contract expectation in the cohort’s signing stage. Provide the ABI or allow switching message semantics to complete the run.

