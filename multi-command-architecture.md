# TaCo Multi-Command Architecture Design

Proposal for supporting multiple command types and dynamic condition selection using a new `ExternalCondition` primitive.

## Overview

We need to support:
1. **Multiple command types** with fundamentally different conditions:
   - `/taco execute` (tips) - validates recipient, amount, account age
   - `/predict bet` - validates market address, outcome, amount
   - `/predict claim` - validates resolution via external API
   - `/quest claim` - validates merkle proof against on-chain root

2. **Server-specific customization** (within commands):
   - Min/max tip amounts per guild
   - Allowed tokens per guild
   - Account age requirements per guild

3. **Dynamic condition updates** without redeploying the entire condition set

---

## Current Architecture

### How Conditions Work Today

- Conditions stored on-chain in `SigningCoordinator` keyed by `(cohortId, chainId)`
- **One condition set per (cohortId, chainId) tuple**
- Bot passes context parameters: `:timestamp`, `:signature`, `:discordPayload`
- All context comes from Discord-signed payload (bot cannot fake it)

### Key Facts

- **Discord payload is trusted:** Everything in payload is signed by Discord
- **External queries supported:** JSON APIs (with JSONPath), on-chain contract calls
- **Condition updates:** Currently require TaCo to deploy new conditions

### Current Tip Condition Structure

```
AND
├── OR (3 Discord public keys for signature rotation)
└── Sequential
    ├── Account age validation (TimeCondition - 7 days)
    ├── Sender salt derivation (keccak256)
    ├── Sender AA computation (contract call)
    ├── Sender validation (matches UserOp sender)
    ├── Amount validation (>= 0.50 USDC)
    ├── Recipient salt derivation
    ├── Recipient AA computation
    └── Calldata validation (execute() ABI)
```

### The Problem

Adding new commands (predict, quest) or per-guild customization requires either:
- **Monolithic if-then-else chains** - complex, hard to audit, depth limits
- **Protocol changes** - new key structures in SigningCoordinator
- **Frequent redeployments** - every config change needs TaCo involvement

---

## Proposed Solution: ExternalCondition

### Concept

A new condition type that **fetches condition JSON from an external source at evaluation time** and evaluates it with full context.

```json
{
  "conditionType": "external",
  "source": {
    "type": "contract",
    "address": "0xConditionRegistry",
    "chain": 84532,
    "method": "getCondition",
    "parameters": [":commandName"]
  }
}
```

### Key Properties

1. **Full context passthrough** - All context variables from the parent scope are available to the fetched condition
2. **No caching** - Fetch every evaluation
3. **Simple failure model** - Fetch fails = condition fails. Fetched condition fails = condition fails.
4. **Source agnostic** - On-chain registry, JSON API, IPFS - the source determines the trust model

### Source Types

#### On-Chain Contract Registry

```json
{
  "conditionType": "external",
  "source": {
    "type": "contract",
    "address": "0xConditionRegistry",
    "chain": 84532,
    "method": "getCondition",
    "parameters": [":commandName"]
  }
}
```

Trust model: On-chain state is canonical. If nodes query the same block, they get the same condition.

#### JSON API

```json
{
  "conditionType": "external",
  "source": {
    "type": "json-api",
    "url": "https://api.example.com/conditions/:commandName"
  }
}
```

Trust model: Trust the API operator. Useful for rapid iteration or centralized deployments.

#### Content-Addressed Storage (IPFS/Arweave)

```json
{
  "conditionType": "external",
  "source": {
    "type": "ipfs",
    "cid": "QmYwAPJzv5CZsnAzt8auVZRn..."
  }
}
```

Trust model: Content-addressed = immutable. CID guarantees the condition hasn't changed.

### Consensus Behavior

If nodes fetch different conditions (due to on-chain state in flux, different RPC endpoints, etc.):
- Some nodes may pass, some may fail
- If threshold isn't met, signing fails
- This is consistent with how any on-chain query inconsistency is handled

**The system doesn't need to guarantee all nodes see the same condition, only that enough agree on the outcome.**

---

## Architecture with ExternalCondition

### Base Condition Structure

The deployed condition handles shared validation and delegates command-specific logic:

```json
{
  "version": "1.0.0",
  "condition": {
    "conditionType": "compound",
    "operator": "and",
    "operands": [
      {
        "conditionType": "compound",
        "operator": "or",
        "operands": [
          {
            "message": ":timestamp:discordPayload",
            "signature": ":signature",
            "verifyingKey": "db55ffb861ef97174c5da1563491ae39444851930aca9111039d875ca7812c23",
            "curve": "Ed25519",
            "conditionType": "ecdsa"
          },
          {
            "message": ":timestamp:discordPayload",
            "signature": ":signature",
            "verifyingKey": "845e32f597ba70fba3586cbd0acbed78b40e01df4b940d01f7a74ee1fd7a43b8",
            "curve": "Ed25519",
            "conditionType": "ecdsa"
          },
          {
            "message": ":timestamp:discordPayload",
            "signature": ":signature",
            "verifyingKey": "d13fe84b134026fc0b26667ea3880779ad1b5dec2170561136929b479ed68800",
            "curve": "Ed25519",
            "conditionType": "ecdsa"
          }
        ]
      },
      {
        "conditionType": "sequential",
        "conditionVariables": [
          {
            "varName": "commandName",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.data.options[0].name",
              "returnValueTest": {
                "comparator": "!=",
                "value": ""
              }
            }
          },
          {
            "varName": "guildId",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.guild_id",
              "returnValueTest": {
                "comparator": "!=",
                "value": ""
              }
            }
          },
          {
            "varName": "senderId",
            "condition": {
              "conditionType": "json",
              "data": ":discordPayload",
              "query": "$.member.user.id",
              "returnValueTest": {
                "comparator": ">",
                "value": 0
              }
            }
          },
          {
            "varName": "senderSalt",
            "condition": {
              "conditionType": "context-variable",
              "contextVariable": ":senderId",
              "returnValueTest": {
                "comparator": ">",
                "value": 0
              }
            },
            "operations": [
              { "operation": "str" },
              { "operation": "+=", "value": "|Discord|Collab.Land" },
              { "operation": "keccak" }
            ]
          },
          {
            "varName": "senderAA",
            "condition": {
              "conditionType": "contract",
              "contractAddress": "0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c",
              "chain": 84532,
              "method": "computeAddress",
              "functionAbi": {
                "name": "computeAddress",
                "type": "function",
                "inputs": [
                  { "name": "_bytecodeHash", "type": "bytes32", "internalType": "bytes32" },
                  { "name": "_salt", "type": "bytes32", "internalType": "bytes32" }
                ],
                "outputs": [
                  { "name": "", "type": "address", "internalType": "address" }
                ],
                "stateMutability": "view"
              },
              "parameters": [
                "0x210ffc0da7f274285c4d6116aaef8420ecb9054faced33862197d6b951cb32f5",
                ":senderSalt"
              ],
              "returnValueTest": {
                "comparator": "!=",
                "value": "0x0000000000000000000000000000000000000000"
              }
            }
          },
          {
            "varName": "commandValidation",
            "condition": {
              "conditionType": "external",
              "source": {
                "type": "contract",
                "address": "0xCommandConditionRegistry",
                "chain": 84532,
                "method": "getCondition",
                "parameters": [":commandName", ":guildId"]
              }
            }
          }
        ]
      }
    ]
  }
}
```

### What the Registry Returns

For `/taco execute`, the registry returns a condition that can use `:senderAA`, `:senderId`, `:guildId`, etc.:

```json
{
  "conditionType": "sequential",
  "conditionVariables": [
    {
      "varName": "validateSender",
      "condition": {
        "signingObjectContextVar": ":signingConditionObject",
        "attributeName": "sender",
        "conditionType": "signing-attribute",
        "returnValueTest": {
          "comparator": "==",
          "value": ":senderAA"
        }
      }
    },
    {
      "varName": "amountUSDC",
      "condition": {
        "conditionType": "json",
        "data": ":discordPayload",
        "query": "$.data.options[0].options[?(@.name == \"amount\")].value",
        "returnValueTest": {
          "comparator": ">=",
          "value": 0.50,
          "operations": [{ "operation": "float" }]
        }
      },
      "operations": [{ "operation": "toTokenBaseUnits", "value": 6 }]
    },
    {
      "varName": "recipientSalt",
      "condition": {
        "conditionType": "json",
        "data": ":discordPayload",
        "query": "$.data.options[0].options[?(@.name == \"receiver\")].value",
        "returnValueTest": {
          "comparator": ">",
          "value": 0
        }
      },
      "operations": [
        { "operation": "str" },
        { "operation": "+=", "value": "|Discord|Collab.Land" },
        { "operation": "keccak" }
      ]
    },
    {
      "varName": "recipientAA",
      "condition": {
        "conditionType": "contract",
        "contractAddress": "0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c",
        "chain": 84532,
        "method": "computeAddress",
        "functionAbi": {
          "name": "computeAddress",
          "type": "function",
          "inputs": [
            { "name": "_bytecodeHash", "type": "bytes32", "internalType": "bytes32" },
            { "name": "_salt", "type": "bytes32", "internalType": "bytes32" }
          ],
          "outputs": [
            { "name": "", "type": "address", "internalType": "address" }
          ],
          "stateMutability": "view"
        },
        "parameters": [
          "0x210ffc0da7f274285c4d6116aaef8420ecb9054faced33862197d6b951cb32f5",
          ":recipientSalt"
        ],
        "returnValueTest": {
          "comparator": "!=",
          "value": "0x0000000000000000000000000000000000000000"
        }
      }
    },
    {
      "varName": "validateCalldata",
      "condition": {
        "signingObjectContextVar": ":signingConditionObject",
        "attributeName": "call_data",
        "conditionType": "signing-abi-attribute",
        "abiValidation": {
          "allowedAbiCalls": {
            "execute((address,uint256,bytes))": [
              {
                "parameterIndex": 0,
                "indexWithinTuple": 0,
                "returnValueTest": {
                  "comparator": "==",
                  "value": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
                }
              },
              {
                "parameterIndex": 0,
                "indexWithinTuple": 1,
                "returnValueTest": {
                  "comparator": "==",
                  "value": 0
                }
              },
              {
                "parameterIndex": 0,
                "indexWithinTuple": 2,
                "nestedAbiValidation": {
                  "allowedAbiCalls": {
                    "transfer(address,uint256)": [
                      {
                        "parameterIndex": 0,
                        "returnValueTest": {
                          "comparator": "==",
                          "value": ":recipientAA"
                        }
                      },
                      {
                        "parameterIndex": 1,
                        "returnValueTest": {
                          "comparator": "==",
                          "value": ":amountUSDC"
                        }
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
```

For `/predict bet`, a completely different condition structure would be returned.

---

## Condition Registry Contract

### Interface

```solidity
interface IConditionRegistry {
    /// @notice Get condition JSON for a command and guild
    /// @param commandName The command identifier (e.g., "execute", "bet", "claim")
    /// @param guildId The Discord guild ID
    /// @return conditionJson The condition JSON as a string
    function getCondition(
        string calldata commandName,
        string calldata guildId
    ) external view returns (string memory conditionJson);
    
    /// @notice Set condition for a command (admin only)
    function setCondition(
        string calldata commandName,
        string calldata conditionJson
    ) external;
    
    /// @notice Set guild-specific condition override
    function setGuildCondition(
        string calldata commandName,
        string calldata guildId,
        string calldata conditionJson
    ) external;
}
```

### Resolution Logic

```solidity
function getCondition(
    string calldata commandName,
    string calldata guildId
) external view returns (string memory) {
    // Check guild-specific override first
    bytes32 guildKey = keccak256(abi.encodePacked(commandName, guildId));
    if (bytes(guildConditions[guildKey]).length > 0) {
        return guildConditions[guildKey];
    }
    
    // Fall back to default command condition
    return defaultConditions[commandName];
}
```

---

## Server-Specific Customization

### Approach 1: Guild-Specific Conditions in Registry

The registry can return different conditions per guild:

```
getCondition("execute", "guild-123") → condition with minTip=0.50
getCondition("execute", "guild-456") → condition with minTip=1.00
getCondition("execute", "guild-789") → default condition
```

### Approach 2: Parameterized Conditions with Config Contract

The fetched condition itself queries a config contract:

```json
{
  "varName": "guildMinTip",
  "condition": {
    "conditionType": "contract",
    "contractAddress": "0xGuildConfig",
    "chain": 84532,
    "method": "getMinTip",
    "parameters": [":guildId"],
    "returnValueTest": { "comparator": ">", "value": 0 }
  }
},
{
  "varName": "validateAmount",
  "condition": {
    "conditionType": "json",
    "data": ":discordPayload",
    "query": "$.data.options[0].options[?(@.name == \"amount\")].value",
    "returnValueTest": {
      "comparator": ">=",
      "value": ":guildMinTip",
      "operations": [{ "operation": "float" }]
    }
  }
}
```

This separates condition logic from configuration data.

---

## Security Considerations

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    TRUSTED                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Discord   │  │    TaCo     │  │  On-Chain   │     │
│  │  Signature  │  │   Cohort    │  │  Registry   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
                          │
                    TRUST BOUNDARY
                          │
┌─────────────────────────────────────────────────────────┐
│                   UNTRUSTED                              │
│  ┌─────────────┐  ┌─────────────┐                      │
│  │  Collab.Land│  │   User's    │                      │
│  │     Bot     │  │   Client    │                      │
│  └─────────────┘  └─────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

### Source Type Trust Model

| Source Type | Trust Model | Use Case |
|-------------|-------------|----------|
| On-chain contract | Trustless - state is canonical | Production deployments |
| JSON API | Trust the operator | Development, centralized systems |
| IPFS/Arweave | Content-addressed, immutable | Auditable, versioned conditions |

### Attack Vectors and Mitigations

| Attack | Mitigation |
|--------|------------|
| Registry returns malicious condition | Registry admin controls - same as current SigningCoordinator |
| Bot sends wrong command | Command extracted from signed Discord payload |
| Guild spoofing | Guild ID from signed Discord payload |
| Replay attacks | Timestamp validation in base condition |

---

## Benefits of ExternalCondition

1. **Clean separation** - Base validation (Discord sig, sender derivation) is stable; command logic is dynamic

2. **No protocol changes** - ExternalCondition is just a new condition type, not a new key structure

3. **Independent updates** - Update tip conditions without touching predict conditions

4. **Guild customization** - Registry can return different conditions per guild without redeploying base conditions

5. **Composability** - External conditions can themselves contain ExternalConditions (with appropriate depth limits)

6. **Auditability** - Each command's condition is a self-contained JSON blob that can be independently reviewed

7. **Fully updateable** - Conditions can be modified at any time by updating the registry

8. **Revocation** - Disable a command or guild by setting a condition that always fails (e.g., `{"conditionType": "json", "data": "false", "query": "$", "returnValueTest": {"comparator": "==", "value": true}}`)

---

## Implementation Considerations

### Recursion and Depth

External conditions can contain nested external conditions. Depth limits should be enforced to prevent infinite loops or DoS.

### Error Handling

- Source unreachable: Condition fails
- Source returns invalid JSON: Condition fails  
- Source returns valid JSON that fails evaluation: Condition fails

No special error handling needed - the existing failure model applies.

### Context Variable Scope

All context variables from the parent scope are available to the fetched condition. The fetched condition can define its own variables, which are scoped to that condition.

---

## Migration Path

### Phase 1: Implement ExternalCondition

Add the `external` condition type to TaCo's condition evaluator.

### Phase 2: Deploy Condition Registry

Deploy a simple registry contract that maps `(commandName, guildId)` to condition JSON.

### Phase 3: Update Base Conditions

Deploy new base conditions that:
1. Handle Discord signature validation
2. Extract common context (senderId, senderAA, guildId)
3. Delegate to ExternalCondition for command-specific logic

### Phase 4: Populate Registry

Add conditions for each command type to the registry.

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
          { "name": "amount", "value": "1.00" },
          { "name": "token", "value": "USDC" }
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
