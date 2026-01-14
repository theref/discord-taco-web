# Discord-Native Prediction Markets with TACo

## Overview

A trust-minimized prediction market system where:
- **Betting** happens on-chain via TaCo-signed UserOps calling a market contract
- **Resolution** is verified by TaCo nodes querying external data sources
- **Payouts** are calculated and distributed by the smart contract

The Discord bot is **untrusted**. All security comes from:
1. Discord signature verification (proves user intent)
2. Smart contract bet tracking (immutable, on-chain state)
3. TaCo oracle consensus (M-of-N nodes verify resolution)
4. Contract-enforced payouts (no off-chain calculation)

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
│  │   Bot   │ ─────────────────────▶  │      TaCo       │            │
│  │(untrust)│    + bet params         │  Cohort (M/N)   │            │
│  └─────────┘                         └────────┬────────┘            │
│                                               │                      │
│                              Conditions:      │                      │
│                              ✓ Discord sig    │                      │
│                              ✓ Market open    │                      │
│                              ✓ Amount matches │                      │
│                              ✓ Outcome valid  │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │  Signed UserOp │              │
│                                      │  user AA calls │              │
│                                      │  contract.bet()│              │
│                                      └───────┬────────┘              │
│                                              │                       │
│                                              ▼                       │
│                                      ┌────────────────┐              │
│                                      │   Contract     │              │
│                                      │ tracks bet in  │              │
│                                      │   mappings     │              │
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
│  ┌─────────┐    Bot determines       ┌─────────────────┐            │
│  │   Bot   │    resolution result    │      TaCo       │            │
│  │(untrust)│ ─────────────────────▶  │  Cohort (M/N)   │            │
│  └─────────┘    UserOp: claim(result)└────────┬────────┘            │
│                                               │                      │
│                              Conditions:      │                      │
│                              ✓ Discord sig    │                      │
│                              ✓ Market ended   │                      │
│                              ✓ TaCo verifies  │                      │
│                                resolution     │                      │
│                              ✓ result param   │                      │
│                                matches        │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │  Signed UserOp │              │
│                                      │  user AA calls │              │
│                                      │ contract.claim │              │
│                                      │    (result)    │              │
│                                      └───────┬────────┘              │
│                                              │                       │
│                                              ▼                       │
│                                      ┌────────────────┐              │
│                                      │   Contract     │              │
│                                      │ verifies winner│              │
│                                      │ calculates &   │              │
│                                      │ sends payout   │              │
│                                      └────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

**Key insight:** TaCo's role is simplified to being an **oracle for the resolution result**. The contract handles all bet tracking, payout calculation, and distribution.

---

## Smart Contract Design

### Single Contract Per Market

Instead of separate YES/NO pool addresses, each market uses a single contract that:
- Escrows all bets in one place
- Tracks who bet what on which outcome
- Calculates and distributes payouts

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract PredictionMarket {
    address public immutable tacoSigner;  // TaCo cohort multisig
    uint256 public immutable endTime;
    
    mapping(address => uint256) public yesBets;
    mapping(address => uint256) public noBets;
    mapping(address => bool) public claimed;
    
    uint256 public totalYes;
    uint256 public totalNo;
    bool public resolved;
    bool public outcome;  // true = YES won, false = NO won
    
    event BetPlaced(address indexed bettor, bool outcome, uint256 amount);
    event Claimed(address indexed bettor, uint256 payout);
    event Resolved(bool outcome);
    
    constructor(address _tacoSigner, uint256 _endTime) {
        tacoSigner = _tacoSigner;
        endTime = _endTime;
    }
    
    /// @notice Place a bet on YES (true) or NO (false)
    /// @dev Called via TaCo-signed UserOp from user's AA wallet
    function bet(bool _outcome) external payable {
        require(block.timestamp < endTime, "Market closed");
        require(msg.value > 0, "Must bet something");
        
        if (_outcome) {
            yesBets[msg.sender] += msg.value;
            totalYes += msg.value;
        } else {
            noBets[msg.sender] += msg.value;
            totalNo += msg.value;
        }
        
        emit BetPlaced(msg.sender, _outcome, msg.value);
    }
    
    /// @notice Claim winnings after resolution
    /// @param result The resolution result (verified by TaCo before signing)
    /// @dev TaCo nodes independently verify result matches oracle data
    function claim(bool result) external {
        require(block.timestamp >= endTime, "Market not ended");
        require(!claimed[msg.sender], "Already claimed");
        
        // First claim resolves the market
        if (!resolved) {
            resolved = true;
            outcome = result;
            emit Resolved(result);
        } else {
            // Subsequent claims must use same result
            require(result == outcome, "Wrong result");
        }
        
        // Check caller bet on winning side
        uint256 userBet = result ? yesBets[msg.sender] : noBets[msg.sender];
        require(userBet > 0, "No winning bet");
        
        // Calculate payout: original bet + share of losing pool
        uint256 winningPool = result ? totalYes : totalNo;
        uint256 losingPool = result ? totalNo : totalYes;
        uint256 payout = userBet + (userBet * losingPool / winningPool);
        
        claimed[msg.sender] = true;
        
        (bool success, ) = msg.sender.call{value: payout}("");
        require(success, "Transfer failed");
        
        emit Claimed(msg.sender, payout);
    }
    
    /// @notice Refund if market is cancelled (admin function)
    function refund() external {
        require(!resolved, "Already resolved");
        
        uint256 userTotal = yesBets[msg.sender] + noBets[msg.sender];
        require(userTotal > 0, "Nothing to refund");
        
        yesBets[msg.sender] = 0;
        noBets[msg.sender] = 0;
        
        (bool success, ) = msg.sender.call{value: userTotal}("");
        require(success, "Transfer failed");
    }
}
```

### Benefits of Single Contract

1. **Funds escrowed in one place** - No split across multiple pool addresses
2. **Contract tracks bets** - No need to reconstruct from event logs
3. **Payout calculation on-chain** - No complex TaCo condition math
4. **Double-claim prevention built-in** - Simple `claimed` mapping
5. **Gas efficient** - Single contract deployment, simple mappings

---

## Deterministic Contract Addresses

Markets are deployed via CREATE2 for deterministic addresses:

```typescript
const marketId = keccak256(
  toUtf8Bytes(`${botAppId}:${questionHash}:${creatorId}:${timestamp}`)
);

const contractSalt = keccak256(
  toUtf8Bytes(`MARKET:${botAppId}:${marketId}`)
);

const marketAddress = CREATE2(factory, contractSalt, marketBytecode);
```

This allows:
- Computing market address before deployment
- Verifying market authenticity from parameters
- No registry needed - address is derivable

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
2. Generates deterministic market ID
3. Deploys market contract (or computes address if using factory)
4. Stores market metadata (question, resolution config)
5. Returns market address

**Market metadata:**
```json
{
  "marketId": "0xabc123...",
  "contractAddress": "0x...",
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
  "token": "ETH"
}
```

### `/predict bet`

```
/predict bet market:<id> outcome:YES amount:0.1
```

The bot:
1. Validates Discord signature
2. Looks up market contract address
3. Builds UserOp: user AA calls `contract.bet{value: amount}(true)` for YES
4. Sends to TaCo for signing
5. Submits to bundler
6. Returns transaction hash

### `/predict status`

```
/predict status market:<id>
```

Shows current betting totals, odds, and time remaining.

### `/predict claim`

```
/predict claim market:<id>
```

The bot:
1. Validates Discord signature
2. Verifies market has ended
3. Queries resolution source (e.g., CoinGecko API)
4. Determines result (YES or NO)
5. Builds UserOp: user AA calls `contract.claim(result)`
6. Sends to TaCo for signing (TaCo independently verifies result)
7. Submits to bundler
8. Contract checks if user won and sends payout

---

## Payout Calculation

The contract calculates payouts using proportional distribution:

```
Total YES bets: 10 ETH
Total NO bets:  5 ETH
Winner: YES

User A bet 2 ETH on YES
User A's share of YES pool: 2/10 = 20%
User A's winnings from NO pool: 5 * 0.2 = 1 ETH
User A's total payout: 2 + 1 = 3 ETH
```

Formula (implemented in contract):
```solidity
payout = userBet + (userBet * losingPool / winningPool)
```

---

## TaCo Conditions

### Betting Condition

Simple validation that the bet matches Discord intent:

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
            "varName": "outcomeBool",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'outcome')].value"
            },
            "operations": [
              {"operation": "==", "value": "YES"}
            ],
            "_comment": "Convert YES/NO to true/false"
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
            "varName": "marketAddress",
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
            "varName": "validateCalldata",
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
                        "value": ":marketAddress"
                      },
                      "_comment": "Transfer goes to market contract"
                    },
                    {
                      "parameterIndex": 0,
                      "indexWithinTuple": 1,
                      "returnValueTest": {
                        "comparator": "==",
                        "value": ":amount"
                      },
                      "_comment": "Value matches Discord amount"
                    },
                    {
                      "parameterIndex": 0,
                      "indexWithinTuple": 2,
                      "nestedAbiValidation": {
                        "allowedAbiCalls": {
                          "bet(bool)": [
                            {
                              "parameterIndex": 0,
                              "returnValueTest": {
                                "comparator": "==",
                                "value": ":outcomeBool"
                              },
                              "_comment": "Outcome matches Discord choice"
                            }
                          ]
                        }
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

### Claim Condition

TaCo verifies the resolution result, contract handles the rest:

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
            "varName": "marketAddress",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'market')].value"
            }
          },
          {
            "varName": "resolutionResult",
            "condition": {
              "conditionType": "json-api",
              "endpoint": "https://api.coingecko.com/api/v3/coins/:asset/history?date=:endDate",
              "query": "$.market_data.current_price.usd",
              "returnValueTest": {
                "comparator": ":resolutionComparator",
                "value": ":resolutionThreshold"
              }
            },
            "_comment": "TaCo independently queries resolution source"
          },
          {
            "varName": "validateCalldata",
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
                        "value": ":marketAddress"
                      }
                    },
                    {
                      "parameterIndex": 0,
                      "indexWithinTuple": 2,
                      "nestedAbiValidation": {
                        "allowedAbiCalls": {
                          "claim(bool)": [
                            {
                              "parameterIndex": 0,
                              "returnValueTest": {
                                "comparator": "==",
                                "value": ":resolutionResult"
                              },
                              "_comment": "Result param matches TaCo's verification"
                            }
                          ]
                        }
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

**Key simplification:** TaCo doesn't calculate payouts or track bets. It just:
1. Verifies Discord signature
2. Queries resolution source to determine result
3. Verifies the `claim(result)` parameter matches

The contract handles everything else.

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

TaCo queries: `https://api.coingecko.com/api/v3/coins/ethereum/history?date=01-06-2025`

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

TaCo queries via `eth_call`.

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

Resolution requires a Discord signature from the designated resolver.

---

## Security Model

### Why the Bot Cannot Cheat

| Attack Vector | Prevention |
|---------------|------------|
| Bot forges bet | TaCo verifies Discord signature |
| Bot changes bet amount | Amount from Discord payload, verified in calldata |
| Bot changes outcome | Outcome from Discord payload, verified in calldata |
| Bot claims with wrong result | TaCo independently verifies resolution |
| Bot pays wrong amount | Contract calculates payout, not bot |
| Bot pays wrong person | Contract pays `msg.sender` (user's AA) |
| Bot double-claims | Contract tracks `claimed` mapping |

### Trust Assumptions

1. **Discord** - Authenticates users and signs interactions
2. **Resolution source** - Price feeds, APIs are accurate
3. **TaCo cohort** - M-of-N honest signers
4. **Smart contract** - Correctly implements payout logic

### What TaCo Provides

TaCo's key value is **consensus on the resolution result**. Multiple independent nodes:
1. Query the resolution source
2. Verify the result
3. Only sign if they agree

This prevents a single point of failure in determining market outcomes.

---

## Edge Cases

### No Bets on One Side

If everyone bets YES and outcome is YES:
- Winners get back original bet (no losers to take from)
- `losingPool = 0`, so `payout = userBet + 0 = userBet`

If everyone bets YES and outcome is NO:
- No winners, funds remain in contract
- Could add admin refund function for edge cases

### Market Cancellation

Add a `cancel()` function callable by admin:
```solidity
function cancel() external onlyAdmin {
    require(!resolved, "Already resolved");
    cancelled = true;
}
```

Users can then call `refund()` to get their bets back.

### Double Claim Prevention

Built into contract:
```solidity
require(!claimed[msg.sender], "Already claimed");
claimed[msg.sender] = true;
```

### First Claim Sets Resolution

The first successful claim "locks in" the resolution:
```solidity
if (!resolved) {
    resolved = true;
    outcome = result;
}
```

This is safe because TaCo only signs claims with the correct result.

---

## Supported Tokens

### ETH

```solidity
function bet(bool _outcome) external payable {
    // msg.value is the bet amount
}
```

### ERC-20 (USDC, etc.)

Would need a separate contract or modified interface:
```solidity
function betToken(bool _outcome, uint256 amount) external {
    token.transferFrom(msg.sender, address(this), amount);
    // Track bet...
}

function claimToken(bool result) external {
    // Calculate payout...
    token.transfer(msg.sender, payout);
}
```

---

## New TaCo Capabilities Required

1. **Historical price API queries** - Query CoinGecko for past prices
2. **Date formatting** - Convert timestamps to API date formats
3. **Dynamic endpoint interpolation** - Insert `:asset`, `:date` into URLs

**Not required (handled by contract):**
- ~~Event log queries~~
- ~~Computed expressions for payout math~~
- ~~Tracking user bets~~

---

## Summary

This simplified design:

| Component | Responsibility |
|-----------|---------------|
| **Discord** | Authenticate users, sign interactions |
| **Bot** | Relay requests, build UserOps (untrusted) |
| **TaCo** | Verify Discord sig, verify resolution result (oracle) |
| **Contract** | Track bets, calculate payouts, distribute funds |

**TaCo as Oracle:** The key value TaCo provides is decentralized consensus on "what is the resolution result?" Multiple nodes independently verify, preventing any single point of manipulation.

**Contract as State:** All bet tracking, payout calculation, and fund distribution happens on-chain in the contract. No complex off-chain computation or log reconstruction.

**Bot as Relay:** The bot is fully untrusted. It can't forge bets (Discord sig), can't lie about results (TaCo verifies), and can't steal funds (contract controls payouts).
