# TaCo Multi-Command Architecture Design

Design exploration document for supporting multiple command types (tip, predict, quest) with server-specific customization within a single Collab.Land cohort.

## Overview

We need to support:
1. **Multiple command types** with fundamentally different conditions:
   - `/taco execute` (tips) - validates recipient, amount, account age
   - `/predict bet` - validates market address, outcome, amount → `bet(bool)` call
   - `/predict claim` - validates resolution via external API → `claim(result)` call  
   - `/quest claim` - validates merkle proof against on-chain root

2. **Server-specific customization** (within commands):
   - Min/max tip amounts per guild
   - Allowed tokens per guild
   - Account age requirements per guild

3. **Constraint:** Single Collab.Land cohort (no multi-cohort option)

---

## Current Architecture

### How Conditions Work Today

- Conditions stored on-chain in `SigningCoordinator` keyed by `(cohortId, chainId)`
- **One condition set per (cohortId, chainId) tuple**
- Bot passes context parameters: `:timestamp`, `:signature`, `:discordPayload`
- All context comes from Discord-signed payload (bot cannot fake it)

### Key Facts

- **Nesting depth limit:** Currently 2, can be increased to 4+ (exists to prevent DoS)
- **Discord payload is trusted:** Everything in payload is signed by Discord
- **External queries supported:** JSON APIs (with JSONPath), on-chain contract calls
- **Condition updates:** No downtime, TaCo deploys new conditions

### Current Tip Condition Structure

```
AND
├── OR (3 Discord public keys for signature rotation)
└── Sequential
    ├── Account age validation (TimeCondition - 7 days)
    ├── Sender salt derivation (keccak256)
    ├── Sender AA computation (contract call)
    ├── Sender validation (matches UserOp sender)
    ├── Amount validation (>= 0.0001 ETH)
    ├── Recipient salt derivation
    ├── Recipient AA computation
    └── Calldata validation (execute() ABI)
```

---

## Architecture Options

### Option A: Command-Derived Condition Routing

**Concept:** Store multiple condition sets, route based on command path extracted from Discord payload.

**How it works:**
1. Store conditions keyed by `(cohortId, chainId, commandHash)`
2. At signing time, TaCo extracts command path from Discord payload:
   - `$.data.name` = "taco" 
   - `$.data.options[0].name` = "execute" | "predict" | "quest"
3. Hash command path deterministically to derive condition set key
4. Bot CANNOT fake this - Discord signature covers the payload

**Condition storage example:**
```
(cohort=3, chain=84532, cmd=hash("taco/execute")) → tipConditions
(cohort=3, chain=84532, cmd=hash("predict/bet"))  → predictBetConditions
(cohort=3, chain=84532, cmd=hash("predict/claim")) → predictClaimConditions
(cohort=3, chain=84532, cmd=hash("quest/claim"))   → questClaimConditions
```

**Pros:**
- Clean separation of concerns
- Update one command's conditions without touching others
- Each condition set is self-contained and auditable
- Scales well to many command types

**Cons:**
- Requires TaCo protocol change (new key structure)
- More condition sets to manage/deploy
- Shared logic (Discord sig validation) duplicated across sets

**Open questions:**
- How to handle subcommands? Hash full path or just top-level?
- What if command doesn't match any registered condition set? Reject or fallback?

---

### Option B: Single "Router" Condition with IfThenElse

**Concept:** One monolithic condition set that branches based on command type.

**Structure:**
```
AND
├── Discord signature validation (shared)
└── IfThenElse
    ├── IF command == "taco/execute" THEN tipConditions
    ├── ELSE IF command == "predict/bet" THEN predictBetConditions
    ├── ELSE IF command == "predict/claim" THEN predictClaimConditions
    ├── ELSE IF command == "quest/claim" THEN questClaimConditions
    └── ELSE REJECT
```

**Pros:**
- No protocol changes needed
- Single condition set to deploy/audit
- Shared validation logic defined once

**Cons:**
- Monolithic - grows unwieldy with many commands
- Updates to one command require redeploying everything
- Depth limit becomes critical (each branch adds depth)
- Harder to reason about / audit

**Open questions:**
- Can IfThenElse handle N branches, or only if/else (2 branches)?
- What's the practical depth limit for complex multi-command conditions?

---

### Option C: Layered/Compositional Conditions

**Concept:** Define reusable condition "modules" that compose together.

**Layers:**
1. **Base layer:** Discord signature verification (always required, runs first)
2. **Command layer:** Command-specific validation (selected by command path)
3. **Parameter layer:** Server-specific values (queried from on-chain config)

**How it works:**
```
BaseCondition (Discord sig) 
    → CommandCondition (selected by payload)
        → queries GuildConfigContract for parameters
```

**On-chain config contract:**
```solidity
contract GuildConfig {
    struct Config {
        uint256 minTipWei;
        uint256 maxTipWei;
        uint256 minAccountAgeDays;
        address[] allowedTokens;
        bool enabled;
    }
    
    // Guild ID (from Discord) → Config
    mapping(bytes32 => Config) public configs;
    
    function getConfig(string calldata guildId) external view returns (Config memory);
}
```

**Condition queries config:**
```json
{
  "varName": "guildMinTip",
  "condition": {
    "conditionType": "contract",
    "contractAddress": "0xGuildConfigContract",
    "method": "getConfig(string)",
    "parameters": [":guildId"],
    "query": "$.minTipWei",
    "returnValueTest": { "comparator": ">", "value": 0 }
  }
}
```

Then validate: `amount >= :guildMinTip`

**Pros:**
- Server-specific params without condition redeployment
- Admins can update their config via tx (no TaCo involvement)
- Reusable base validation
- Cleanest separation of "what" vs "how much"

**Cons:**
- Requires on-chain config contract deployment
- Additional contract call per signing request (latency/cost?)
- Config contract becomes critical infrastructure
- Need governance for who can update configs

**Cross-domain composability example:**
Could the same "Discord signature validation" module be used by:
- Collab.Land tipping cohort
- A different prediction market cohort
- A third-party quest system

This is a **major architectural question** - should TaCo support shared/imported condition modules across cohorts?

---

### Option D: Hybrid (Command Routing + On-Chain Config)

**Concept:** Combine Option A (command routing) with Option C (on-chain config).

**Structure:**
1. **Command routing:** Different condition sets per command type
2. **Parameterization:** Each condition set queries on-chain config for server-specific values
3. **Base validation:** Could be a "prerequisite" condition that runs before command-specific

**Flow:**
```
SigningRequest arrives
    → TaCo extracts command from payload
    → Routes to command-specific condition set
    → Condition set:
        1. Validates Discord signature
        2. Queries GuildConfig contract for params
        3. Validates command-specific logic with guild params
```

**Pros:**
- Best of both worlds: clean separation + parameterization
- Commands isolated, params flexible
- Scales well

**Cons:**
- Most complex to implement
- Two new mechanisms (routing + config queries)

---

## Server-Specific Parameters

### What Should Be Configurable Per Guild?

| Parameter | Example | Trustless Enforcement? |
|-----------|---------|----------------------|
| Min tip amount | 0.0001 ETH | Yes - query config contract |
| Max tip amount | 1 ETH | Yes - query config contract |
| Allowed tokens | [ETH, USDC] | Yes - query allowlist |
| Account age | 7 days | Yes - TimeCondition |
| Fee percentage | 1% | Yes - validate in calldata |
| Enabled/disabled | true | Yes - check flag |

### Config Update Governance

**Options:**
1. **TaCo admin only** - centralized but simple
2. **Guild admin** - requires verifying Discord admin role somehow
3. **On-chain governance** - multisig or token voting per guild
4. **Hybrid** - TaCo sets defaults, guild admins can only restrict further

**Key question:** How do we verify a Discord guild admin on-chain?
- Could require a signed Discord interaction from an admin
- Or link guild to an Ethereum address that controls config

---

## Condition Composability

This deserves special attention as it has broader implications.

### Current State

- Conditions are self-contained JSON blobs
- No imports, no references, no inheritance
- Shared logic must be copy-pasted

### Potential: Condition Modules

**Define once:**
```json
{
  "moduleId": "discord-sig-validation-v1",
  "condition": {
    "conditionType": "compound",
    "operator": "or",
    "operands": [
      { "conditionType": "ecdsa", "verifyingKey": "key1", "..." : "..." },
      { "conditionType": "ecdsa", "verifyingKey": "key2", "..." : "..." },
      { "conditionType": "ecdsa", "verifyingKey": "key3", "..." : "..." }
    ]
  }
}
```

**Reference in other conditions:**
```json
{
  "conditionType": "module-ref",
  "moduleId": "discord-sig-validation-v1"
}
```

### Cross-Domain Examples

1. **Discord signature validation** - Any Discord-integrated app
2. **Account age check** - Any Sybil-resistance use case  
3. **AA address derivation** - Any Collab.Land AA user
4. **Merkle proof validation** - Any airdrop/allowlist system

### Questions for Discussion

- Should modules be globally registered or cohort-scoped?
- How to version modules? What if a module is updated?
- Can modules have parameters? (e.g., `discord-sig-validation(keys=[...])`)
- Trust model: who can publish modules?

---

## Token Type Handling

### The Challenge

Different token types have fundamentally different calldata structures:

| Token Type | Calldata Structure |
|------------|-------------------|
| **ETH** | `execute((address,uint256,bytes))` - value in tuple position 1 |
| **ERC-20** | `execute((address,uint256,bytes))` - value=0, bytes=`transfer(address,uint256)` |
| **ERC-721 (NFT)** | `execute((address,uint256,bytes))` - value=0, bytes=`transferFrom(address,address,uint256)` |
| **ERC-1155** | `execute((address,uint256,bytes))` - value=0, bytes=`safeTransferFrom(...)` |

### Options for Token Handling

**Option T1: Branch within condition based on token param**
```
IF token == "ETH" THEN
  validateEthTransfer
ELSE IF token == "USDC" THEN
  validateErc20Transfer  
ELSE IF token == "NFT" THEN
  validateNftTransfer
```
- Pros: Single condition set for all tips
- Cons: Adds depth, grows with each new token

**Option T2: Separate condition sets per token category**
```
(cohort, chain, cmd=hash("taco/execute/ETH"))   → ethTipConditions
(cohort, chain, cmd=hash("taco/execute/ERC20")) → erc20TipConditions
(cohort, chain, cmd=hash("taco/execute/NFT"))   → nftTipConditions
```
- Pros: Clean separation, easy to add new token types
- Cons: More condition sets, token must be in routing key

**Option T3: Generic calldata validation with token-specific nested ABI**
Use `nestedAbiValidation` that's already in the schema:
```json
{
  "parameterIndex": 0,
  "indexWithinTuple": 2,
  "nestedAbiValidation": {
    "allowedAbiCalls": {
      "transfer(address,uint256)": ["..."],
      "transferFrom(address,address,uint256)": ["..."],
      "safeTransferFrom(address,address,uint256,uint256,bytes)": ["..."]
    }
  }
}
```
- Pros: Single condition handles multiple token types
- Cons: All allowed ABIs must be pre-registered

### Token Allowlists

Per-guild token allowlists add another dimension:
- Guild A allows: ETH, USDC
- Guild B allows: ETH, USDC, WETH, DAI
- Guild C allows: ETH only

This could be enforced via:
1. **On-chain allowlist query:** Check if `(guildId, tokenAddress)` is in allowlist
2. **Condition branching:** Different guilds have different allowed ABIs
3. **Hybrid:** Global token support, per-guild enable/disable

### NFT Considerations (Future)

NFTs introduce additional complexity:
- **Token ID validation:** Which NFT can be tipped?
- **Collection allowlists:** Only certain NFT collections?
- **Ownership verification:** Does sender own the NFT?
- **Amount:** Always 1 for ERC-721, variable for ERC-1155

---

## Default Configuration

### Bootstrap Problem

When a new guild starts using the bot, it needs working conditions immediately.

**Approach: Tiered Defaults**

```
Global Defaults (hardcoded in conditions)
    ↓ overridden by
Guild Config Contract (if entry exists)
    ↓ overridden by  
Nothing (guild config is final)
```

**Global defaults example:**
```json
{
  "minTipWei": "100000000000000",
  "maxTipWei": "1000000000000000000",
  "minAccountAgeDays": 7,
  "allowedTokens": ["ETH"],
  "feePercent": 1,
  "enabled": true
}
```

### Config Contract Design

```solidity
contract GuildConfig {
    struct Config {
        bool exists;
        uint256 minTipWei;
        uint256 maxTipWei;
        uint256 minAccountAgeDays;
        uint8 feePercent;
        bool enabled;
    }
    
    mapping(bytes32 => Config) public configs;
    mapping(bytes32 => mapping(address => bool)) public allowedTokens;
    Config public defaults;
    
    function getEffectiveConfig(string calldata guildId) external view returns (Config memory) {
        bytes32 key = keccak256(bytes(guildId));
        if (configs[key].exists) {
            return configs[key];
        }
        return defaults;
    }
}
```

---

## Security Considerations

### Attack Vectors

| Attack | Description | Mitigation |
|--------|-------------|------------|
| **Command spoofing** | Bot sends wrong command type | Command derived from signed payload |
| **Guild spoofing** | Bot claims wrong guild ID | Guild ID from signed payload |
| **Config manipulation** | Attacker changes guild config | Governance on config contract |
| **Token substitution** | Bot swaps token in calldata | Validate token matches payload |
| **Amount manipulation** | Bot changes amount | Amount from payload, validated in calldata |
| **Replay attacks** | Reuse old signed payload | Timestamp/nonce validation |
| **Depth limit DoS** | Craft condition that times out | Depth limits, gas limits |

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    TRUSTED                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Discord   │  │    TaCo     │  │  On-Chain   │     │
│  │  Signature  │  │   Cohort    │  │  Contracts  │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
                          │
                    TRUST BOUNDARY
                          │
┌────────────────────────────────────────────────��────────┐
│                   UNTRUSTED                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Collab.Land│  │   User's    │  │  External   │     │
│  │     Bot     │  │   Client    │  │    APIs     │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

Everything the bot sends must be validated against the signed Discord payload.

---

## Cost Analysis

### On-Chain Config Contract Queries

Each signing request that queries the GuildConfig contract adds:
- **1 eth_call** per config lookup (view function, no gas cost to user)
- **Latency:** ~100-500ms depending on RPC provider
- **TaCo node cost:** Minimal (RPC calls are cheap)

**Storage costs (one-time per guild):**

| Operation | Estimated Gas | Cost at 1 gwei | Cost at 10 gwei |
|-----------|---------------|----------------|-----------------|
| Set guild config | ~100,000 gas | ~$0.01 | ~$0.10 |
| Add token to allowlist | ~50,000 gas | ~$0.005 | ~$0.05 |
| Update single param | ~30,000 gas | ~$0.003 | ~$0.03 |

### Condition Deployment Costs

Conditions are stored on-chain in SigningCoordinator:

| Condition Size | Estimated Gas | Cost at 1 gwei | Cost at 10 gwei |
|----------------|---------------|----------------|-----------------|
| 280 lines (~10KB) | ~500,000 gas | ~$0.05 | ~$0.50 |
| 800 lines (~30KB) | ~1,500,000 gas | ~$0.15 | ~$1.50 |

### Operational Costs Comparison

| Approach | Deployment Cost | Per-Request Cost | Update Frequency |
|----------|-----------------|------------------|------------------|
| Option A (Routing) | Higher (N conditions) | Same | Per-command |
| Option B (Router) | Lower (1 condition) | Same | Any change |
| Option C (Layered) | Medium | +1 RPC call | Rare |
| Option D (Hybrid) | Higher | +1 RPC call | Per-command or param |

---

## Concrete Examples

### Example: Option B Router Condition (Simplified)

```json
{
  "version": "1.0.0",
  "condition": {
    "conditionType": "compound",
    "operator": "and",
    "operands": [
      {
        "_comment": "SHARED: Discord signature validation",
        "conditionType": "compound",
        "operator": "or",
        "operands": [
          { "conditionType": "ecdsa", "message": ":timestamp:discordPayload", "signature": ":signature", "verifyingKey": "key1", "curve": "Ed25519" },
          { "conditionType": "ecdsa", "message": ":timestamp:discordPayload", "signature": ":signature", "verifyingKey": "key2", "curve": "Ed25519" },
          { "conditionType": "ecdsa", "message": ":timestamp:discordPayload", "signature": ":signature", "verifyingKey": "key3", "curve": "Ed25519" }
        ]
      },
      {
        "_comment": "ROUTER: Branch based on command",
        "conditionType": "sequential",
        "conditionVariables": [
          {
            "varName": "commandName",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[0].name",
              "returnValueTest": { "comparator": "!=", "value": "" }
            }
          },
          {
            "varName": "commandResult",
            "condition": {
              "conditionType": "if-then-else",
              "ifCondition": {
                "conditionType": "json",
                "data": ":commandName",
                "query": "$",
                "returnValueTest": { "comparator": "==", "value": "execute" }
              },
              "thenCondition": {
                "_comment": "TIP CONDITIONS GO HERE",
                "conditionType": "sequential",
                "conditionVariables": []
              },
              "elseCondition": {
                "conditionType": "if-then-else",
                "ifCondition": {
                  "conditionType": "json",
                  "data": ":commandName",
                  "query": "$",
                  "returnValueTest": { "comparator": "==", "value": "bet" }
                },
                "thenCondition": {
                  "_comment": "PREDICT BET CONDITIONS GO HERE",
                  "conditionType": "sequential",
                  "conditionVariables": []
                },
                "elseCondition": {
                  "_comment": "REJECT: Unknown command",
                  "conditionType": "json",
                  "data": "false",
                  "query": "$",
                  "returnValueTest": { "comparator": "==", "value": true }
                }
              }
            }
          }
        ]
      }
    ]
  }
}
```

**Depth analysis:**
- Level 1: Top-level AND
- Level 2: Sequential (router)
- Level 3: if-then-else (command check)
- Level 4: Nested if-then-else OR command-specific sequential
- Level 5: Command-specific logic

**This requires depth limit of at least 5** for complex commands.

### Example: Guild Config Query in Condition

```json
{
  "varName": "guildConfig",
  "condition": {
    "conditionType": "contract",
    "contractAddress": "0xGuildConfigContract",
    "chain": 84532,
    "method": "getEffectiveConfig",
    "functionAbi": {
      "name": "getEffectiveConfig",
      "type": "function",
      "inputs": [{ "name": "guildId", "type": "string" }],
      "outputs": [
        { "name": "exists", "type": "bool" },
        { "name": "minTipWei", "type": "uint256" },
        { "name": "maxTipWei", "type": "uint256" },
        { "name": "minAccountAgeDays", "type": "uint256" },
        { "name": "feePercent", "type": "uint8" },
        { "name": "enabled", "type": "bool" }
      ]
    },
    "parameters": [":guildId"],
    "returnValueTest": { "comparator": "!=", "value": null }
  }
}
```

### Example: Token Allowlist Check

```json
{
  "varName": "tokenAllowed",
  "condition": {
    "conditionType": "contract",
    "contractAddress": "0xGuildConfigContract",
    "chain": 84532,
    "method": "isTokenAllowed",
    "functionAbi": {
      "name": "isTokenAllowed",
      "type": "function",
      "inputs": [
        { "name": "guildId", "type": "string" },
        { "name": "token", "type": "address" }
      ],
      "outputs": [{ "name": "", "type": "bool" }]
    },
    "parameters": [":guildId", ":tokenAddress"],
    "returnValueTest": { "comparator": "==", "value": true }
  }
}
```

---

## Decision Points

### Decision 1: Command Routing Mechanism

**Question:** How should TaCo select which conditions to evaluate for a signing request?

| Option | Description | Effort | Recommendation |
|--------|-------------|--------|----------------|
| **A. Protocol-level routing** | New key structure: `(cohort, chain, commandHash)` | High | Best long-term |
| **B. In-condition routing** | Single condition with if-then-else branching | Low | Good for MVP |

**Factors to consider:**
- How many commands do we expect? (3? 10? 50?)
- How often do individual commands change?
- Is auditability important?

### Decision 2: Server Customization Approach

**Question:** How should per-guild parameters be managed?

| Option | Description | Effort | Recommendation |
|--------|-------------|--------|----------------|
| **A. Hardcoded defaults only** | No customization, same rules for all | None | Simplest |
| **B. On-chain config contract** | Guild admins set params via tx | Medium | Most flexible |
| **C. Condition variants** | Different condition sets for different tiers | Medium | Limited flexibility |

**Factors to consider:**
- How important is per-guild customization?
- Who should control guild settings?
- How do we bootstrap trust with guild admins?

### Decision 3: Condition Composability

**Question:** Should TaCo support reusable condition modules?

| Option | Description | Effort | Recommendation |
|--------|-------------|--------|----------------|
| **A. No modularity** | Self-contained conditions (current) | None | Simplest |
| **B. Cohort-scoped modules** | Modules shared within a cohort | Medium | Good balance |
| **C. Global modules** | Modules shared across all cohorts | High | Most powerful |

**Factors to consider:**
- How much shared logic exists across commands?
- Are there other cohorts that would benefit from shared modules?
- What's the trust model for module publishers?

### Decision 4: Token Type Handling

**Question:** How should different token types (ETH, ERC-20, NFT) be handled?

| Option | Description | Effort | Recommendation |
|--------|-------------|--------|----------------|
| **A. Branching in condition** | if-then-else based on token param | Low | Quick to implement |
| **B. Separate condition sets** | Route by token type | Medium | Cleanest |
| **C. Generic ABI validation** | Allow multiple ABIs in one condition | Low | Flexible |

### Decision 5: Depth Limit

**Question:** What nesting depth limit should TaCo enforce?

| Option | Depth | Enables |
|--------|-------|---------|
| **Current** | 2 | Simple conditions only |
| **Proposed** | 4 | Router + command logic |
| **Extended** | 6+ | Deep composition |

### Decision 6: Migration Strategy

**Question:** How do we get from current state to target architecture?

| Phase | Changes | Timeline |
|-------|---------|----------|
| **1. MVP** | Option B router, hardcoded defaults | Immediate |
| **2. Config** | Add GuildConfig contract, query in conditions | +1 month |
| **3. Routing** | Implement Option A if needed | +3 months |
| **4. Modules** | Condition composability | +6 months |

---

## Comparison Matrix

| Criteria | Option A (Routing) | Option B (Router) | Option C (Layered) | Option D (Hybrid) |
|----------|-------------------|-------------------|-------------------|-------------------|
| **Protocol changes** | Yes (new key) | No | Maybe (modules) | Yes |
| **Deployment granularity** | Per-command | All-or-nothing | Per-layer | Per-command |
| **Condition complexity** | Low per set | High (monolithic) | Medium | Medium |
| **Depth usage** | Minimal | High | Medium | Medium |
| **Server customization** | Requires config | Requires config | Native | Native |
| **New command effort** | Deploy new set | Edit monolith | Add layer | Deploy + config |
| **Auditability** | High | Low | Medium | High |
| **Scalability** | Excellent | Poor | Good | Excellent |

---

## Unresolved Questions

1. **Condition versioning:** If a condition set is updated, what happens to in-flight signing requests?

2. **Rollback strategy:** If a new condition set has a bug, how quickly can we rollback?

3. **Testing conditions:** How do we test condition changes before deploying to production?

4. **Monitoring/observability:** How do we know if conditions are failing?

5. **Rate limiting:** Can conditions enforce rate limits (e.g., max 10 tips per hour per user)?

6. **Cross-chain considerations:** If the same command is used on multiple chains, do conditions need to differ?

7. **Emergency shutdown:** Can a guild or TaCo admin quickly disable all signing for a command/guild?

---

## Related Work

Worth investigating how similar problems are solved elsewhere:

- **Snapshot voting:** How do they handle different voting strategies per space?
- **Safe (Gnosis):** How do modules and guards provide customizable security?
- **Lit Protocol:** How do they handle programmable signing conditions?
- **Chainlink Functions:** How do they handle custom off-chain computation?

---

## Next Steps

1. **Internal discussion:** Review options A-D, identify favorites
2. **Technical feasibility:** Which options are implementable with what effort?
3. **Prototype:** Build simplest version (likely Option B or C) to validate
4. **Iterate:** Refine based on learnings

---

## Appendix: Discord Payload Structure

For reference, the Discord interaction payload contains:

```json
{
  "type": 2,
  "data": {
    "name": "taco",
    "options": [
      {
        "name": "execute",
        "type": 1,
        "options": [
          { "name": "receiver", "value": "412648164710023168" },
          { "name": "amount", "value": "0.001" },
          { "name": "token", "value": "ETH" }
        ]
      }
    ]
  },
  "guild_id": "1435631433543581777",
  "member": {
    "user": { "id": "405651072460259339" }
  }
}
```

**Trusted fields (signed by Discord):**
- `data.name` - Top-level command ("taco")
- `data.options[].name` - Subcommand ("execute")
- `data.options[].options[]` - Parameters (receiver, amount, token)
- `guild_id` - Discord server ID
- `member.user.id` - Sender Discord ID
