# Discord-Native Prediction Markets with TACo

## Overview

A trust-minimized prediction market system where:
- **Betting** happens on-chain via TACo-signed UserOps
- **Resolution** is verified by TACo nodes querying external data sources
- **Payouts** are enforced cryptographically by TACo conditions

The Discord bot is **untrusted**. All security comes from:
1. Discord signature verification (proves user intent to bet)
2. On-chain bet records (immutable proof of bets)
3. TACo oracle consensus (M-of-N nodes verify resolution)
4. Cryptographic binding of payouts to bet amounts and outcomes

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BETTING FLOW                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Discord User                                                        │
│       │                                                              │
│       │ /predict bet <market_id> <outcome> <amount>                  │
│       ▼                                                              │
│  ┌─────────┐    Discord Signature    ┌─────────────────┐            │
│  │   Bot   │ ─────────────────────▶  │      TACo       │            │
│  │(untrust)│    + bet params         │  Cohort (M/N)   │            │
│  └─────────┘                         └────────┬────────┘            │
│                                               │                      │
│                              Conditions:      │                      │
│                              ✓ Discord sig    │                      │
│                              ✓ Market exists  │                      │
│                              ✓ Market open    │                      │
│                              ✓ Amount matches │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │  Signed UserOp │              │
│                                      │  (user AA →    │              │
│                                      │   outcome pool)│              │
│                                      └───────┬────────┘              │
│                                              │                       │
│                                              ▼                       │
│                                      ┌────────────────┐              │
│                                      │    Bundler     │              │
│                                      │  (on-chain tx) │              │
│                                      └────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         CLAIM FLOW                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Discord User (winner)                                               │
│       │                                                              │
│       │ /predict claim <market_id>                                   │
│       ▼                                                              │
│  ┌─────────┐    Claim request        ┌─────────────────┐            │
│  │   Bot   │ ─────────────────────▶  │      TACo       │            │
│  │(untrust)│                         │  Cohort (M/N)   │            │
│  └─────────┘                         └────────┬────────┘            │
│                                               │                      │
│                              Conditions:      │                      │
│                              ✓ Market ended   │                      │
│                              ✓ Resolution     │                      │
│                                verified       │                      │
│                              ✓ User bet on    │                      │
│                                winning side   │                      │
│                              ✓ Payout amount  │                      │
│                                is correct     │                      │
│                              ✓ Not already    │                      │
│                                claimed        │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │  Signed UserOp │              │
│                                      │  (pool AA →    │              │
│                                      │   user AA)     │              │
│                                      └───────┬────────┘              │
│                                              │                       │
│                                              ▼                       │
│                                      ┌────────────────┐              │
│                                      │    Bundler     │              │
│                                      │  (on-chain tx) │              │
│                                      └────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deterministic Pool Addresses

Each market has two pool addresses derived deterministically:

```typescript
const marketId = "eth-5000-june-2025";

const yesPoolSalt = keccak256(
  toUtf8Bytes(`MARKET:${botAppId}:${marketId}:YES`)
);
const noPoolSalt = keccak256(
  toUtf8Bytes(`MARKET:${botAppId}:${marketId}:NO`)
);

const yesPoolAddress = CREATE2(factory, yesPoolSalt, bytecode);
const noPoolAddress = CREATE2(factory, noPoolSalt, bytecode);
```

Both pools are TACo-controlled AA wallets. The bot cannot withdraw from them - only TACo-signed UserOps can move funds.

---

## User Experience

### `/predict create`

```
/predict create 
    question:"Will ETH be above $5000 on June 1st 2025?"
    end_date:2025-06-01
    resolution_type:price_feed
    resolution_source:coingecko
    resolution_asset:ethereum
    resolution_threshold:5000
```

The bot:
1. Validates Discord signature
2. Generates deterministic market ID from question hash + creator + timestamp
3. Derives YES and NO pool addresses
4. Stores market metadata (question, end date, resolution config)
5. Returns market ID and pool addresses

**Market metadata stored on-chain or IPFS:**
```json
{
  "marketId": "0xabc123...",
  "question": "Will ETH be above $5000 on June 1st 2025?",
  "creator": "discord:123456789",
  "createdAt": 1704067200,
  "endDate": 1748736000,
  "resolution": {
    "type": "price_feed",
    "source": "coingecko",
    "asset": "ethereum",
    "comparator": ">",
    "threshold": 5000
  },
  "yesPool": "0x...",
  "noPool": "0x...",
  "token": "ETH"
}
```

### `/predict bet`

```
/predict bet market:<id> outcome:YES amount:0.1
```

The bot:
1. Validates Discord signature
2. Verifies market exists and is still open (end_date not passed)
3. Derives user's AA address from Discord ID
4. Builds UserOp: transfer `amount` from user AA → YES pool (or NO pool)
5. Sends to TACo for signing
6. Submits to bundler
7. Returns transaction hash

### `/predict resolve`

```
/predict resolve market:<id>
```

Anyone can call this after the end date. The bot:
1. Fetches market metadata
2. Verifies end_date has passed
3. Queries resolution source (e.g., CoinGecko API for ETH price)
4. Determines winning outcome (YES or NO)
5. Stores resolution result (on-chain or IPFS)
6. Returns result

**Note:** This step is informational. The actual resolution verification happens in TACo conditions when users claim.

### `/predict claim`

```
/predict claim market:<id>
```

The bot:
1. Validates Discord signature
2. Derives user's AA address
3. Queries on-chain: user's bet amount to winning pool
4. Queries on-chain: total bets on winning side, total bets on losing side
5. Calculates payout: `userBet + (userBet / winningTotal) * losingTotal`
6. Builds UserOp: transfer payout from winning pool → user AA
7. Sends to TACo for signing (conditions verify everything)
8. Submits to bundler

---

## Payout Calculation

Simple proportional payout from the losing pool to winners:

```
Total YES bets: 10 ETH
Total NO bets:  5 ETH
Winner: YES

User A bet 2 ETH on YES
User A's share of YES pool: 2/10 = 20%
User A's winnings from NO pool: 5 * 0.2 = 1 ETH
User A's total payout: 2 + 1 = 3 ETH
```

Formula:
```
payout = userBet + (userBet / winningPoolTotal) * losingPoolTotal
```

Or equivalently:
```
payout = userBet * (winningPoolTotal + losingPoolTotal) / winningPoolTotal
```

---

## TACo Conditions

### Betting Condition

Authorizes TACo to sign bet transfers.

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
            "varName": "marketId",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'market')].value",
              "returnValueTest": {
                "comparator": "!=",
                "value": ""
              }
            }
          },
          {
            "varName": "outcome",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'outcome')].value",
              "returnValueTest": {
                "comparator": "in",
                "value": ["YES", "NO"]
              }
            }
          },
          {
            "varName": "amount",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'amount')].value",
              "returnValueTest": {
                "comparator": ">",
                "value": 0
              }
            },
            "operations": [{"operation": "ethToWei"}]
          },
          {
            "varName": "marketEndDate",
            "condition": {
              "conditionType": "json-api",
              "endpoint": ":marketMetadataEndpoint",
              "query": "$.endDate",
              "returnValueTest": {
                "comparator": ">",
                "value": ":currentTimestamp"
              }
            }
          },
          {
            "varName": "validTransfer",
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
                        "value": ":expectedPoolAddress"
                      }
                    },
                    {
                      "parameterIndex": 0,
                      "indexWithinTuple": 1,
                      "returnValueTest": {
                        "comparator": "==",
                        "value": ":amount"
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
- Discord signature verification (proves user intent)
- Extracts market ID, outcome, and amount from Discord payload
- Verifies market is still open (end date not passed)
- Verifies UserOp transfers to correct pool address (YES or NO based on outcome)
- Verifies UserOp amount matches what user requested

### Claim Condition

Authorizes TACo to sign payout transfers from pool to winner.

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
            "varName": "marketId",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'market')].value",
              "returnValueTest": {
                "comparator": "!=",
                "value": ""
              }
            }
          },
          {
            "varName": "marketEnded",
            "condition": {
              "conditionType": "json-api",
              "endpoint": ":marketMetadataEndpoint",
              "query": "$.endDate",
              "returnValueTest": {
                "comparator": "<",
                "value": ":currentTimestamp"
              }
            }
          },
          {
            "varName": "resolutionResult",
            "condition": {
              "conditionType": "json-api",
              "endpoint": "https://api.coingecko.com/api/v3/coins/:asset/history?date=:endDateFormatted",
              "query": "$.market_data.current_price.usd",
              "returnValueTest": {
                "comparator": ":resolutionComparator",
                "value": ":resolutionThreshold"
              }
            }
          },
          {
            "varName": "winningOutcome",
            "condition": {
              "conditionType": "computed",
              "expression": "resolutionResult ? 'YES' : 'NO'"
            }
          },
          {
            "varName": "userBetAmount",
            "condition": {
              "conditionType": "json-rpc",
              "endpoint": ":rpcEndpoint",
              "method": "eth_getBalance",
              "params": [":userAA", "latest"],
              "comment": "TODO: Query user's transfer to winning pool"
            }
          },
          {
            "varName": "winningPoolTotal",
            "condition": {
              "conditionType": "json-rpc",
              "endpoint": ":rpcEndpoint",
              "method": "eth_getBalance",
              "params": [":winningPoolAddress", "latest"]
            }
          },
          {
            "varName": "losingPoolTotal",
            "condition": {
              "conditionType": "json-rpc",
              "endpoint": ":rpcEndpoint",
              "method": "eth_getBalance",
              "params": [":losingPoolAddress", "latest"]
            }
          },
          {
            "varName": "expectedPayout",
            "condition": {
              "conditionType": "computed",
              "expression": "userBetAmount * (winningPoolTotal + losingPoolTotal) / winningPoolTotal"
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
                        "value": ":expectedPayout"
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
- Verifies market has ended
- Queries resolution source (e.g., CoinGecko) to determine winning outcome
- TACo nodes reach consensus on the resolution
- Queries on-chain for user's bet amount on winning side
- Queries pool balances to calculate proportional payout
- Verifies UserOp payout amount matches calculated expected payout
- Verifies payout goes to the claimer's AA address

---

## Resolution Types

### Price Feed (CoinGecko, CryptoCompare, etc.)

```json
{
  "type": "price_feed",
  "source": "coingecko",
  "asset": "ethereum",
  "comparator": ">",
  "threshold": 5000,
  "date": "2025-06-01"
}
```

TACo queries: `https://api.coingecko.com/api/v3/coins/ethereum/history?date=01-06-2025`

### On-Chain State

```json
{
  "type": "onchain",
  "chain": 1,
  "contract": "0x...",
  "method": "balanceOf(address)",
  "params": ["0x..."],
  "comparator": ">",
  "threshold": 1000000
}
```

TACo queries via `json-rpc` condition.

### External API

```json
{
  "type": "api",
  "endpoint": "https://api.sportsdata.io/v3/nfl/scores/...",
  "query": "$.winner",
  "comparator": "==",
  "value": "Kansas City Chiefs"
}
```

### Admin Declaration

```json
{
  "type": "admin",
  "resolver": "discord:123456789"
}
```

Resolution requires a Discord signature from the designated resolver declaring the outcome.

---

## Tracking User Bets On-Chain

To calculate payouts, we need to know how much each user bet on the winning side.

**Challenge:** Pool balance shows total, but not per-user breakdown.

**Solutions:**

### Option A: Event Logs

The AA wallet's `execute()` emits events. TACo can query:
```
eth_getLogs({
  address: winningPoolAddress,
  topics: [keccak256("Received(address,uint256)")],
  fromBlock: marketCreationBlock
})
```

Filter for transfers from the claimer's AA address.

### Option B: Transaction History via Indexer

Query an indexer (Etherscan API, The Graph, etc.) for transactions to the pool address from the user's AA.

### Option C: Commit Bet Hash On-Chain

When betting, include a hash of (marketId, outcome, userAA, amount) in the transaction data. At claim time, verify the hash exists.

**Recommendation:** Option A (event logs) if the AA emits events, otherwise Option B (indexer query).

---

## Security Model

### Why the Bot Cannot Cheat

| Attack Vector | Prevention |
|---------------|------------|
| Bot forges bet | TACo verifies Discord signature |
| Bot changes bet amount | Amount extracted from Discord payload, bound to UserOp |
| Bot changes outcome | Outcome extracted from Discord payload, determines pool address |
| Bot pays wrong amount | TACo calculates expected payout from on-chain data |
| Bot pays wrong person | Payout recipient derived from Discord ID, verified in UserOp |
| Bot resolves incorrectly | TACo queries resolution source directly |
| Bot claims for losers | TACo verifies user bet on winning side |

### Trust Assumptions

1. **Discord** - Authenticates users and signs interactions
2. **Resolution source** - Price feeds, APIs, or admin signatures are accurate
3. **TACo cohort** - M-of-N honest signers enforce conditions
4. **On-chain** - Final source of truth for bets and payouts

---

## Edge Cases

### No Bets on One Side

If everyone bets YES and the outcome is YES:
- Winners get back their original bet (no profit)
- `losingPoolTotal = 0`, so `payout = userBet`

If everyone bets YES and the outcome is NO:
- No one can claim (no winners)
- Funds remain in YES pool
- Could add a "refund" mechanism for unresolvable markets

### Market Cancellation

If a market needs to be cancelled:
- Admin signs cancellation message
- TACo condition allows refunds: everyone gets their bet back
- Both pools return funds to original bettors

### Double Claim Prevention

TACo condition must verify user hasn't already claimed:
- Query on-chain for transfers from winning pool to user AA after market end date
- If any exist, deny claim

---

## Supported Tokens

### ETH
Direct value transfer in UserOp.

### ERC-20 (USDC, tBTC, etc.)

UserOp calldata calls token contract:
```
token.transfer(poolAddress, amount)
```

Pool addresses are the same, but the "balance" is queried via:
```
token.balanceOf(poolAddress)
```

TACo conditions would use `eth_call` to query ERC-20 balances.

---

## Future Extensions

1. **Multi-outcome markets** - More than YES/NO (e.g., "Which team wins?")
2. **AMM pricing** - Dynamic odds based on bet ratios
3. **Partial claims** - Claim a percentage before full resolution
4. **Market creation fees** - Small fee to prevent spam
5. **Dispute resolution** - Challenge mechanism for subjective markets
6. **Liquidity provision** - LPs provide initial liquidity for better odds
7. **Cross-server markets** - Markets visible across Discord servers

---

## New TACo Capabilities Required

1. **Historical price API queries** - Query CoinGecko/etc. for past prices
2. **Event log queries** - `eth_getLogs` to find user's bet transactions
3. **Computed expressions** - Calculate payout from pool ratios
4. **Date/time comparisons** - Verify market end date has passed

---

## Summary

This design enables:
- **Trustless betting** via TACo-signed UserOps
- **TACo as oracle** - nodes query resolution sources and reach consensus
- **On-chain bet tracking** - blockchain is the database
- **Proportional payouts** - winners split the losing pool
- **Discord-native UX** with `/predict create`, `/predict bet`, `/predict claim`

The bot is a relay, not an authority. TACo is the cryptographic oracle that turns market outcomes into irreversible on-chain payouts.
