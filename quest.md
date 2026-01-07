# Discord-Native Quests with TACo

## Overview

A quest/competition system where:
- **Participants** are known via initial airdrop (recorded on-chain)
- **Activity** is tracked on-chain (tip transactions)
- **Rankings** are computed by the bot and published as a merkle root
- **Prizes** are held in a TACo-controlled AA wallet
- **Claims** are verified via merkle proofs

### Trust Model

The bot is trusted to compute rankings correctly, but:
- **Cannot steal funds** - TACo controls the prize pool
- **Cannot pay non-winners** - merkle proof required
- **Cannot overpay** - prize amounts are in the merkle tree
- **Is publicly auditable** - anyone can verify rankings from on-chain data

If the bot publishes an incorrect merkle root, anyone can detect this by recomputing from on-chain transactions. This provides social/reputational accountability rather than cryptographic enforcement of rankings.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      QUEST SETUP FLOW                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Discord Admin                                                       │
│       │                                                              │
│       │ /quest create "Tipping Launch" duration:14d prizes:10       │
│       ▼                                                              │
│  ┌─────────┐                         ┌─────────────────┐            │
│  │   Bot   │ ─────────────────────▶  │  Derive Prize   │            │
│  │         │                         │  Pool AA Addr   │            │
│  └─────────┘                         └────────┬────────┘            │
│                                               │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │ Prize Pool AA  │              │
│                                      │ (TACo-controlled)             │
│                                      └────────────────┘              │
│                                               │                      │
│                              Admin funds the pool                    │
│                                               │                      │
│                              Bot airdrops to participants            │
│                              (records participant list on-chain)     │
│                                               ▼                      │
│                                      Quest is ACTIVE                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      DURING QUEST                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Users tip each other normally with /tip                             │
│  (no changes to tipping - quest is a side game)                      │
│       │                                                              │
│       │ All tips recorded on-chain                                   │
│       ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                     On-Chain Record                          │    │
│  │                                                              │    │
│  │  Block 1000: UserA_AA → UserB_AA (0.01 ETH)                 │    │
│  │  Block 1001: UserC_AA → UserA_AA (0.02 ETH)                 │    │
│  │  Block 1002: UserA_AA → UserD_AA (0.01 ETH)                 │    │
│  │  ...                                                         │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      QUEST END + MERKLE PUBLISH                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Quest duration ends                                                 │
│       │                                                              │
│       ▼                                                              │
│  ┌─────────┐                                                        │
│  │   Bot   │ 1. Query on-chain: all tips between participant AAs    │
│  │         │ 2. Count tips sent per address                         │
│  │         │ 3. Rank by count, assign prizes                        │
│  │         │ 4. Build merkle tree of (address, rank, prize)         │
│  │         │ 5. Publish merkle root on-chain                        │
│  │         │ 6. Publish full ranking data (IPFS/public)             │
│  └─────────┘                                                        │
│       │                                                              │
│       │  Anyone can verify:                                          │
│       │  - Recompute rankings from on-chain tips                     │
│       │  - Hash published data → should match on-chain root          │
│       ▼                                                              │
│                                                                      │
│  Claims are now open                                                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         CLAIM FLOW                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Discord User                                                        │
│       │                                                              │
│       │ /quest claim <quest_id>                                      │
│       ▼                                                              │
│  ┌─────────┐    Discord Sig +        ┌─────────────────┐            │
│  │   Bot   │    Merkle Proof    ──▶  │      TACo       │            │
│  │         │    (addr,rank,prize)    │  Cohort (M/N)   │            │
│  └─────────┘                         └────────┬────────┘            │
│                                               │                      │
│                              TACo Verifies:   │                      │
│                              ✓ Discord sig    │                      │
│                              ✓ Merkle proof   │                      │
│                                valid vs root  │                      │
│                              ✓ Rank <= 10     │                      │
│                              ✓ Payout matches │                      │
│                                proof amount   │                      │
│                              ✓ Not already    │                      │
│                                claimed        │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │  Signed UserOp │              │
│                                      │  (prize pool → │              │
│                                      │   winner AA)   │              │
│                                      └───────┬────────┘              │
│                                              │                       │
│                                              ▼                       │
│                                      ┌────────────────┐              │
│                                      │    Bundler     │              │
│                                      └────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Participant Tracking

Participants are known because they receive an initial airdrop:

```typescript
// At quest start, bot airdrops to all participants
const participants = [
  { discordId: "123456789", aa: "0xabc..." },
  { discordId: "987654321", aa: "0xdef..." },
  // ...
];

// Each airdrop is recorded on-chain
// This creates the definitive participant list
```

When computing rankings, the bot only counts tips:
- FROM a participant AA address
- TO a participant AA address
- Within the quest block range
- Excluding self-tips (sender == recipient)

---

## Merkle Tree Structure

After the quest ends, the bot builds a merkle tree:

```typescript
// Leaf data for each winner
interface WinnerLeaf {
  address: Address;    // User's AA address
  rank: number;        // 1-10
  prize: bigint;       // Prize amount in wei
}

// Build leaves
const leaves = winners.map(w => 
  keccak256(encodePacked(
    ['address', 'uint256', 'uint256'],
    [w.address, w.rank, w.prize]
  ))
);

// Build merkle tree
const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
const root = tree.getRoot();

// Publish root on-chain (single tx)
await questContract.setMerkleRoot(questId, root);

// Publish full data publicly for verification
await ipfs.add(JSON.stringify({
  questId,
  rankings: winners,
  root: root.toString('hex'),
  blockRange: { start: startBlock, end: endBlock }
}));
```

---

## Deterministic Prize Pool Address

Each quest has a prize pool AA derived from the quest ID:

```typescript
const questId = "tipping-launch-jan-2025";

const prizePoolSalt = keccak256(
  toUtf8Bytes(`QUEST:${botAppId}:${questId}:PRIZE_POOL`)
);

const prizePoolAddress = CREATE2(factory, prizePoolSalt, bytecode);
```

The prize pool is a TACo-controlled AA wallet.

---

## User Experience

### `/quest create` (Admin Only)

```
/quest create 
    name:"Tipping Launch Competition"
    duration:14d
    winners:10
    prize_total:1000
    token:USDC
```

The bot:
1. Validates Discord signature + admin role
2. Generates quest ID
3. Derives prize pool AA address
4. Records quest metadata
5. Returns quest ID and prize pool address for funding

### `/quest fund`

```
/quest fund quest:<id> amount:1000
```

Admin funds the prize pool via TACo-signed transfer.

### `/quest airdrop`

```
/quest airdrop quest:<id> users:@user1,@user2,... amount:0.01
```

Admin triggers airdrop to participants:
1. Derives AA address for each Discord user
2. TACo signs transfers from prize pool to each participant
3. Records participant list on-chain

### `/quest leaderboard`

```
/quest leaderboard quest:<id>
```

Shows current standings (informational, computed from on-chain data).

### `/quest finalize` (After Quest Ends)

```
/quest finalize quest:<id>
```

Anyone can trigger this after end date:
1. Bot queries all tips between participants in block range
2. Counts by sender, ranks
3. Builds merkle tree
4. Publishes root on-chain
5. Publishes full ranking data to IPFS

### `/quest claim`

```
/quest claim quest:<id>
```

The bot:
1. Validates Discord signature
2. Looks up user's merkle proof from published data
3. Sends claim request to TACo with proof
4. TACo verifies proof against on-chain root
5. TACo signs payout UserOp
6. Submits to bundler

---

## TACo Conditions

### Claim Condition

TACo verifies merkle proofs, not rankings:

```json
{
  "version": "1.0.0",
  "condition": {
    "conditionType": "compound",
    "operator": "and",
    "operands": [
      {
        "conditionType": "ecdsa",
        "message": ":timestamp:discordPayload",
        "signature": ":signature",
        "verifyingKey": "<DISCORD_PUBLIC_KEY>",
        "curve": "Ed25519"
      },
      {
        "conditionType": "sequential",
        "conditionVariables": [
          {
            "varName": "questId",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'quest')].value"
            }
          },
          {
            "varName": "merkleRoot",
            "condition": {
              "conditionType": "json-rpc",
              "endpoint": ":rpcEndpoint",
              "method": "eth_call",
              "params": [{
                "to": ":questContractAddress",
                "data": ":getMerkleRootCalldata"
              }],
              "comment": "Query on-chain merkle root for this quest"
            }
          },
          {
            "varName": "proofValid",
            "condition": {
              "conditionType": "merkle-proof",
              "root": ":merkleRoot",
              "leaf": ":claimLeafHash",
              "proof": ":merkleProof",
              "returnValueTest": {
                "comparator": "==",
                "value": true
              }
            }
          },
          {
            "varName": "isWinner",
            "condition": {
              "conditionType": "computed",
              "expression": "claimRank <= questWinnerCount",
              "returnValueTest": {
                "comparator": "==",
                "value": true
              }
            }
          },
          {
            "varName": "notAlreadyClaimed",
            "condition": {
              "conditionType": "json-rpc",
              "endpoint": ":rpcEndpoint",
              "method": "eth_getLogs",
              "params": [{
                "address": ":prizePoolAddress",
                "fromBlock": ":questEndBlock",
                "topics": [":transferTopic", null, ":claimerAATopic"]
              }],
              "returnValueTest": {
                "comparator": "length",
                "value": 0
              }
            }
          },
          {
            "varName": "validPayout",
            "condition": {
              "conditionType": "signing-abi-attribute",
              "signingObjectContextVar": ":signingConditionObject",
              "attributeName": "call_data",
              "abiValidation": {
                "allowedAbiCalls": {
                  "execute((address,uint256,bytes))": [
                    {
                      "parameterIndex": 0,
                      "indexWithinTuple": 0,
                      "returnValueTest": {
                        "comparator": "==",
                        "value": ":claimerAA"
                      }
                    },
                    {
                      "parameterIndex": 0,
                      "indexWithinTuple": 1,
                      "returnValueTest": {
                        "comparator": "==",
                        "value": ":claimPrizeAmount"
                      }
                    }
                  ]
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

**Key points:**
- Fetches merkle root from on-chain storage
- Verifies merkle proof is valid
- Verifies rank qualifies for prize
- Verifies no previous claim
- Verifies payout matches proof amount

---

## Prize Distribution

Fixed tiers (recommended for MVP):

```
1st place:  200 USDC (20%)
2nd place:  150 USDC (15%)
3rd place:  100 USDC (10%)
4th place:   80 USDC (8%)
5th place:   70 USDC (7%)
6th place:   60 USDC (6%)
7th place:   50 USDC (5%)
8th place:   40 USDC (4%)
9th place:   30 USDC (3%)
10th place:  20 USDC (2%)
Reserved:   200 USDC (unclaimed buffer)
```

---

## Security Model

### What TACo Guarantees

| Property | How TACo Enforces |
|----------|-------------------|
| Only merkle-proven winners can claim | Verifies proof against on-chain root |
| Correct prize amounts | Amount is in merkle leaf, verified in UserOp |
| No double claims | Checks for previous transfers from pool |
| Funds go to claimer | Recipient address verified in UserOp |

### What TACo Does NOT Guarantee

| Property | Why Not | Mitigation |
|----------|---------|------------|
| Rankings are correct | Bot computes rankings | Public verifiability |
| Merkle root is honest | Bot publishes root | Anyone can recompute and verify |

### Public Verifiability

Anyone can verify the bot was honest:

1. Query on-chain tips between participant AAs in block range
2. Count by sender, sort by count
3. Build merkle tree from rankings
4. Compare computed root to published root
5. If mismatch → bot cheated (public scandal)

The bot cannot secretly cheat. It can only openly cheat, which destroys reputation.

---

## Sybil Resistance

Handled in the Discord bot:

- **Discord account age > 30 days** - checked before airdrop
- **Self-tips excluded** - not counted in rankings
- **Only airdropped participants count** - can't join mid-quest

---

## Edge Cases

### Ties at Cutoff

If positions 10 and 11 have the same count:
- Both included as winners
- Split position 10's prize between them

### Not Enough Participants

If fewer than 10 active tippers:
- All active participants are winners
- Prizes distributed among them

### Claim Deadline

Claims open for 30 days after finalization. Unclaimed prizes:
- Return to admin/sponsor, OR
- Roll into next quest

---

## Future Extensions

### Galxe-Style Quest Types

```
/quest create type:tips_sent ...        # Most tips sent
/quest create type:volume_sent ...      # Most value sent
/quest create type:unique_recipients ...# Tip most different people
/quest create type:first_n ...          # First N users to tip
```

### Multi-Action Quests

Requirements across multiple activities (tips + votes + predictions).

### Credential/Badge System

Quest completion earns on-chain credentials (NFTs/SBTs).

---

## New TACo Capabilities Required

1. **Merkle proof verification** - verify inclusion proof against root
2. **On-chain storage queries** - fetch merkle root from contract
3. **Transfer event log queries** - check for previous claims

---

## Summary

This design enables:
- **Frictionless participation** - tipping works exactly as before
- **Known participant set** - via initial airdrop
- **Efficient claims** - merkle proofs, not heavy on-chain computation
- **Public verifiability** - anyone can audit rankings
- **TACo-controlled prizes** - bot cannot steal or misdirect funds

The bot is trusted to compute rankings honestly, but is publicly auditable. TACo enforces that only proven winners receive their correct prize amounts.
