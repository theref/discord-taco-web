# Discord-Native Governance with Snapshot + TACo

## Overview

A trust-minimized governance system where:
- **Voting** happens off-chain via Snapshot (gasless, fast)
- **Execution** happens on-chain via ERC-4337 UserOps
- **TACo** enforces authorization rules cryptographically

The Discord bot is **untrusted**. All security comes from:
1. Discord signature verification (proves user intent)
2. Snapshot API verification (proves governance outcome)
3. Cryptographic binding of votes/executions to their parameters

This follows the same trust model as the existing tipping bot.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         VOTING FLOW                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Discord User                                                        │
│       │                                                              │
│       │ /vote <proposal_id> <choice>                                 │
│       ▼                                                              │
│  ┌─────────┐    Discord Signature    ┌─────────────────┐            │
│  │   Bot   │ ─────────────────────▶  │      TACo       │            │
│  │(untrust)│    + vote params        │  Cohort (M/N)   │            │
│  └─────────┘                         └────────┬────────┘            │
│                                               │                      │
│                              Conditions:      │                      │
│                              ✓ Discord sig    │                      │
│                              ✓ Valid proposal │                      │
│                              ✓ User's AA addr │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │  EIP-1271 Sig  │              │
│                                      │  (for user AA) │              │
│                                      └───────┬────────┘              │
│                                              │                       │
│                                              ▼                       │
│                                      ┌────────────────┐              │
│                                      │    Snapshot    │              │
│                                      │  (records vote)│              │
│                                      └────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       EXECUTION FLOW                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Anyone (bot, user, automated watcher)                               │
│       │                                                              │
│       │ /execute <proposal_id>                                       │
│       ▼                                                              │
│  ┌─────────┐    UserOp + proposal    ┌─────────────────┐            │
│  │Trigger  │ ─────────────────────▶  │      TACo       │            │
│  │(untrust)│                         │  Cohort (M/N)   │            │
│  └─────────┘                         └────────┬────────┘            │
│                                               │                      │
│                              Conditions:      │                      │
│                              ✓ Snapshot API:  │                      │
│                                - state=closed │                      │
│                                - quorum met   │                      │
│                                - winner known │                      │
│                              ✓ UserOp matches │                      │
│                                execution hash │                      │
│                                of winner      │                      │
│                                               ▼                      │
│                                      ┌────────────────┐              │
│                                      │  Signed UserOp │              │
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

## User Experience

### `/propose` (Admin Only)

```
/propose title:"Upgrade contract to v2" 
         description:"This upgrades..." 
         options:"Approve,Reject"
         execution_approve:"0x..." 
         execution_reject:"0x..."
         duration:7d
```

**Requires Discord admin role.** The bot:
1. Validates Discord signature (same as voting/tipping)
2. Verifies user has admin role in the Discord server
3. Computes `executionHash` for each option: `keccak256(chainId, proposalId, target, value, calldata)`
4. Creates Snapshot proposal with execution hashes in metadata
5. Publishes to Snapshot
6. Returns proposal ID and link

### `/vote`

```
/vote proposal:<id> choice:Approve
```

The bot:
1. Validates Discord signature
2. Derives user's AA address from Discord ID
3. Builds EIP-712 Snapshot vote message
4. Sends to TACo for EIP-1271 signing
5. Submits signed vote to Snapshot

The vote is recorded as coming from the user's AA wallet.

### `/execute`

```
/execute proposal:<id>
```

Anyone can run this (or it can be automated). The bot:
1. Fetches proposal state from Snapshot API
2. Verifies vote is closed, quorum met, winner determined
3. Builds UserOp matching the winning option's execution payload
4. Sends to TACo for signing
5. Submits to bundler

---

## Deterministic AA Addresses

Same pattern as tipping bot:

```
salt = keccak256("SALT:BOT_APP_ID:DISCORD_USER_ID")
AA_address = CREATE2(factory, salt, bytecode)
```

Each Discord user has a deterministic, TACo-controlled AA wallet.

---

## TACo Conditions

### Proposal Condition (Admin Only)

Authorizes TACo to create proposals only for Discord admins.

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
        "conditionType": "json",
        "data": ":discordPayload",
        "query": "$.member.permissions",
        "returnValueTest": {
          "comparator": "contains",
          "value": "ADMINISTRATOR"
        }
      }
    ]
  }
}
```

**Note:** Discord permissions are passed in the interaction payload. The condition verifies the user has admin permissions before allowing proposal creation.

### Voting Condition

Authorizes TACo to sign Snapshot votes on behalf of users.

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
            "varName": "proposalId",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'proposal')].value",
              "returnValueTest": {
                "comparator": "!=",
                "value": ""
              }
            }
          },
          {
            "varName": "choice",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[?(@.name == 'choice')].value",
              "returnValueTest": {
                "comparator": "!=",
                "value": ""
              }
            }
          },
          {
            "varName": "snapshotVoteValid",
            "condition": {
              "conditionType": "json-api",
              "endpoint": "https://hub.snapshot.org/graphql",
              "method": "POST",
              "body": {
                "query": "query($id:String!){proposal(id:$id){state}}",
                "variables": { "id": ":proposalId" }
              },
              "query": "$.data.proposal.state",
              "returnValueTest": {
                "comparator": "==",
                "value": "active"
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
- Discord signature verification (same as tipping)
- Extracts proposal ID and choice from Discord payload
- Verifies proposal is still active via Snapshot API
- TACo signs EIP-1271 message for user's AA wallet

### Execution Condition

Authorizes TACo to sign UserOps when governance conditions are met.

```json
{
  "version": "1.0.0",
  "condition": {
    "conditionType": "compound",
    "operator": "and",
    "operands": [
      {
        "conditionType": "sequential",
        "conditionVariables": [
          {
            "varName": "proposalId",
            "condition": {
              "conditionType": "json",
              "data": ":executionRequest",
              "query": "$.proposalId",
              "returnValueTest": {
                "comparator": "!=",
                "value": ""
              }
            }
          },
          {
            "varName": "proposalState",
            "condition": {
              "conditionType": "json-api",
              "endpoint": "https://hub.snapshot.org/graphql",
              "method": "POST",
              "body": {
                "query": "query($id:String!){proposal(id:$id){state scores scores_total choices space{plugins}}}",
                "variables": { "id": ":proposalId" }
              },
              "query": "$.data.proposal.state",
              "returnValueTest": {
                "comparator": "==",
                "value": "closed"
              }
            }
          },
          {
            "varName": "quorumMet",
            "condition": {
              "conditionType": "json-api",
              "endpoint": "https://hub.snapshot.org/graphql",
              "method": "POST", 
              "body": {
                "query": "query($id:String!){proposal(id:$id){scores_total space{plugins}}}",
                "variables": { "id": ":proposalId" }
              },
              "query": "$.data.proposal",
              "returnValueTest": {
                "comparator": "custom",
                "value": "scores_total >= space.plugins.quorum.total"
              }
            }
          },
          {
            "varName": "winningChoice",
            "condition": {
              "conditionType": "json-api",
              "endpoint": "https://hub.snapshot.org/graphql",
              "method": "POST",
              "body": {
                "query": "query($id:String!){proposal(id:$id){scores choices}}",
                "variables": { "id": ":proposalId" }
              },
              "query": "$.data.proposal",
              "returnValueTest": {
                "comparator": "custom",
                "value": "choices[scores.indexOf(Math.max(...scores))]"
              }
            }
          },
          {
            "varName": "executionHashValid",
            "condition": {
              "conditionType": "signing-abi-attribute",
              "signingObjectContextVar": ":signingConditionObject",
              "attributeName": "call_data",
              "abiValidation": {
                "allowedAbiCalls": {
                  "execute((address,uint256,bytes))": [
                    {
                      "parameterIndex": 0,
                      "returnValueTest": {
                        "comparator": "==",
                        "value": ":expectedExecutionHash"
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
- Queries Snapshot API for proposal state
- Verifies proposal is closed
- Verifies quorum is met
- Determines winning choice
- Verifies UserOp calldata matches the execution hash bound to the winner

---

## EIP-1271 Signing

For voting, TACo needs to sign Snapshot vote messages. Snapshot accepts EIP-1271 signatures where the signer is a smart contract.

**Snapshot Vote EIP-712 Structure:**

```typescript
const domain = {
  name: "snapshot",
  version: "0.1.4"
};

const types = {
  Vote: [
    { name: "from", type: "address" },
    { name: "space", type: "string" },
    { name: "timestamp", type: "uint64" },
    { name: "proposal", type: "bytes32" },
    { name: "choice", type: "uint32" },
    { name: "reason", type: "string" },
    { name: "app", type: "string" },
    { name: "metadata", type: "string" }
  ]
};
```

The user's AA wallet implements `isValidSignature(bytes32 hash, bytes signature)` which verifies the TACo threshold signature.

**New TACo capability required:** Sign arbitrary EIP-712 typed data (not just UserOps).

---

## Execution Hash Binding

When a proposal is created, each choice is bound to an execution payload. The execution hash includes all fields necessary for full security:

```typescript
interface ExecutionPayload {
  chainId: number;         // Prevents cross-chain replay
  proposalId: string;      // Binds to specific proposal
  target: Address;
  value: bigint;
  calldata: `0x${string}`;
}

const executionHash = keccak256(
  encodePacked(
    ['uint256', 'bytes32', 'address', 'uint256', 'bytes'], 
    [payload.chainId, payload.proposalId, payload.target, payload.value, payload.calldata]
  )
);
```

The execution hash is stored in Snapshot proposal metadata:

```json
{
  "choices": ["Approve", "Reject"],
  "metadata": {
    "chainId": 84532,
    "executionHashes": {
      "Approve": "0xabc...",
      "Reject": "0x000..."
    },
    "executionPayloads": {
      "Approve": {
        "target": "0x...",
        "value": "0",
        "calldata": "0x..."
      },
      "Reject": null
    }
  }
}
```

---

## Security Model

### Why the Bot Cannot Cheat

| Attack Vector | Prevention |
|---------------|------------|
| Bot forges vote | TACo verifies Discord signature; cannot forge Ed25519 |
| Bot votes for wrong choice | Choice extracted from Discord payload, not bot |
| Bot executes wrong action | UserOp must match execution hash of winning choice |
| Bot executes before vote ends | TACo verifies `state == "closed"` via Snapshot API |
| Bot ignores quorum | TACo verifies quorum via Snapshot API |
| Bot submits to wrong bundler | Signature is valid regardless; on-chain result is what matters |

### Trust Assumptions

1. **Discord** - Authenticates users and signs interactions
2. **Snapshot** - Accurately records and reports votes
3. **TACo cohort** - M-of-N honest signers enforce conditions
4. **On-chain** - Final source of truth for execution

The bot, frontend, and trigger mechanism are all untrusted.

---

## Comparison to On-Chain Governance

| Property | On-Chain Governor | This Design |
|----------|-------------------|-------------|
| Voting cost | Gas per vote | Free (off-chain) |
| Execution cost | Gas | Gas (same) |
| Voting speed | Block time | Instant |
| Trust model | Smart contract | TACo + Snapshot |
| Upgradability | Requires governance | Condition updates |
| Transparency | On-chain | Snapshot + on-chain execution |

---

## Future Extensions

1. **Delegation** - Allow users to delegate voting power to other Discord users
2. **Multiple frontends** - Web UI, Telegram, etc. (same TACo conditions)
3. **On-chain execution markers** - Executor contract that marks proposals as executed (prevents replay)
4. **Timelock** - Add delay between vote close and execution eligibility
5. **Veto** - Allow certain roles to block execution within timelock period

---

## Voting Type

**Single-choice voting only** (for initial implementation).

The winner is determined by the choice with the highest score. Future versions may support:
- Approval voting
- Ranked-choice voting
- Quadratic voting
- Weighted voting

---

## New TACo Capabilities Required

1. **EIP-712 message signing** - Sign typed data for Snapshot votes (not just UserOps)
2. **JSON-API condition with POST** - Query Snapshot GraphQL with variables
3. **Complex return value tests** - Compare computed values (quorum check, winner determination)

---

## Summary

This design enables:
- **Gasless voting** via Snapshot
- **Automatic execution** via TACo-signed UserOps
- **Trust minimization** via cryptographic condition enforcement
- **Discord-native UX** with `/propose`, `/vote`, `/execute`

The bot is a relay, not an authority. TACo is the cryptographic judge that turns collective intent into irreversible on-chain action.
