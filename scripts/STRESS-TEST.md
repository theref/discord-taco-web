# TACo Stress Test

A CLI tool for benchmarking TACo threshold signing performance under load. It replays real Discord interaction payloads through the full signing pipeline and generates HTML reports with charts and statistics.

## Prerequisites

- Node.js 18+
- A `.env` file with RPC endpoints, bundler URL, and TACo config (see `.env` section below)
- At least one captured Discord payload (see "Capturing Payloads" below)
- The local `taco-web` packages linked (the project uses `link:../taco-web/packages/*`)

## Quick Start

```bash
# 1. Copy the example config and add your captured payload(s)
cp stress-test.config.example.yml stress-test.config.yml

# 2. Run a full sweep test (recommended first run)
npm run stress-test -- --config=stress-test.config.yml --mode=sweep

# 3. Open the generated HTML report
open stress-test-results/reports/<timestamp>.html
```

## Test Modes

### Sweep (recommended)

Runs all steady-rate tests followed by all burst tests in sequence, with cooldown periods between each. This gives you a complete picture of performance across different load levels.

```bash
npm run stress-test -- --config=stress-test.config.yml --mode=sweep
```

### Steady

Fires requests at a fixed rate (requests per minute). Useful for testing sustained throughput at a specific load level.

```bash
# 10 requests/min for 60 seconds
npm run stress-test -- --config=stress-test.config.yml --mode=steady --rate=10 --duration=60

# With stop conditions (generates a timeline report)
npm run stress-test -- --config=stress-test.config.yml --rate=30 --max-duration=300 --max-failures=5
```

In steady mode, requests are fired at the interval regardless of whether previous requests have completed. Since each TACo signing takes ~6-15s, higher rates will have many requests in-flight concurrently.

### Burst

Fires N requests simultaneously, waits for all to complete, then repeats. Tests how the system handles concurrent spikes.

```bash
# 10 concurrent requests, 3 batches
npm run stress-test -- --config=stress-test.config.yml --mode=burst --rate=10
```

## CLI Options

| Option | Default | Description |
|---|---|---|
| `--config=<file>` | *(required)* | Path to YAML config file |
| `--mode=<mode>` | `steady` | `steady`, `burst`, or `sweep` |
| `--rate=<n>` | `1` | Requests/min (steady) or burst size (burst) |
| `--duration=<sec>` | `60` | Duration per rate level in steady mode |
| `--requests=<n>` | - | Fixed request count (overrides `--duration`) |
| `--rates=<list>` | - | Comma-separated rates for sweep steady tests |
| `--max-duration=<sec>` | - | Stop after this many seconds (steady mode) |
| `--max-failures=<n>` | - | Stop after N consecutive failures (steady mode) |
| `--output=<file>` | auto | Custom output path for the HTML report |
| `--from-data=<file>` | - | Regenerate report from saved JSON data |
| `--regenerate` | - | Regenerate report from the most recent data file |

## Config File

The config file (`stress-test.config.yml`) defines default parameters and the Discord payloads to replay. An example config is provided at `stress-test.config.example.yml`.

```yaml
defaults:
  mode: sweep
  duration: 60                    # seconds per steady rate level
  rates: [10, 30, 60, 120]       # requests/min to test in sweep
  burstSizes: [3, 5, 10, 20]     # concurrent requests to test in sweep
  batchesPerBurst: 1              # batches per burst size
  rate: 3                         # default rate for single-mode runs
  cooldown: 120                   # seconds between test phases
  timeout: 120                    # seconds before a request times out

payloads:
  - name: "tip-usdc"
    timestamp: "1770113615"
    signature: "75496c98..."
    recipientUserId: "412648164710023168"
    bodyJson: '{"type":2,...}'
```

The config file is gitignored because it contains real Discord payloads with signatures.

### Config Defaults Reference

| Key | Default | Description |
|---|---|---|
| `mode` | `steady` | Default test mode |
| `duration` | `60` | Seconds per steady rate level |
| `rates` | `[0.5, 1, 3, 5, 10]` | Rates to test in sweep mode (requests/min) |
| `burstSizes` | `[1, 3, 5, 10]` | Burst sizes to test in sweep mode |
| `batchesPerBurst` | `10` | How many batches per burst size |
| `rate` | `1` | Default rate for single-mode runs |
| `cooldown` | `30` | Seconds between test phases |
| `timeout` | `120` | Per-request timeout in seconds |

## Capturing Payloads

The stress test replays real Discord interaction payloads. To capture one:

1. Run the bot normally (`npm run bot:dev`)
2. Send a `/taco execute` command in Discord (e.g., tip USDC to someone)
3. Look for the payload data in the bot logs
4. Copy the `timestamp`, `signature`, `recipientUserId`, and the full request body JSON into your config file

Each payload entry needs:
- **timestamp**: The `x-signature-timestamp` header from Discord
- **signature**: The `x-signature-ed25519` header (hex, no `0x` prefix)
- **recipientUserId**: The Discord user ID of the tip recipient
- **bodyJson**: The full Discord interaction body as a single-line JSON string

You can add multiple payloads. The test round-robins through them.

## Required Environment Variables

These must be set in your `.env` file:

| Variable | Example | Description |
|---|---|---|
| `ETH_RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` | Ethereum RPC for the signing coordinator contract |
| `SIGNING_CHAIN_RPC_URL` | `https://base-sepolia.drpc.org` | Base Sepolia RPC for the signing chain |
| `BUNDLER_URL` | `https://api.pimlico.io/v2/84532/rpc?apikey=...` | ERC-4337 bundler (Pimlico) |
| `TACO_DOMAIN` | `lynx` | TACo domain (`lynx` for testnet) |
| `COHORT_ID` | `3` | TACo signing cohort ID |

## Output

Every test run produces two files:

- **Data**: `stress-test-results/data/<timestamp>.json` — raw results, can be used to regenerate reports
- **Report**: `stress-test-results/reports/<timestamp>.html` — interactive HTML report with charts

### Regenerating Reports

You can regenerate an HTML report from saved data without re-running the test:

```bash
# From a specific data file
npm run stress-test -- --from-data=stress-test-results/data/2026-02-05-152524.json

# From the most recent data file
npm run stress-test -- --regenerate

# With a custom output path
npm run stress-test -- --regenerate --output=my-report.html
```

## Reading the Results

### Console Output

During a test, each completed request prints a line like:

```
[012s] Completed 5/10 | in-flight: 3 | ok 11823ms | rpc:313ms req:12ms porter:11693ms dec:15ms
```

- **`012s`**: Elapsed time since test start
- **`in-flight`**: Requests still waiting for a response
- **`ok/FAIL`**: Whether the signing succeeded
- **`rpc`**: Time fetching participants + threshold from the signing coordinator (RPC calls inside taco-web)
- **`req`**: Time building signing requests locally (crypto operations)
- **`porter`**: Round-trip time to Porter and the TACo nodes — this is where almost all latency comes from
- **`dec`**: Time decrypting and aggregating the signatures locally

### HTML Report

The report includes:

- **Summary cards**: Total requests, success rate, success/failure counts
- **Charts**: Success rate and response time plotted against request rate or burst size
- **Detailed tables**: Per-rate/burst statistics with min, p50, p95, p99 breakdowns
- **Timing breakdown**: Stats for each stage of the signing pipeline (RPC, build requests, Porter round-trip, decrypt)
- **Error analysis**: Grouped error types with counts and per-node failure breakdown
- **Notes field**: Editable text area (saved to localStorage) for annotating results

### What to Look For

- **Baseline latency**: At low rates (e.g., 10/min), what's the typical signing time? This is your best-case.
- **Degradation point**: At what rate does the success rate start dropping or latency start climbing?
- **Porter dominance**: The `porter` timing should be 95%+ of total time. If `rpc` is high, your RPC endpoint may be slow.
- **Node timeouts**: Check the error analysis for which nodes are timing out. One slow node can cause threshold failures.

## How It Works

### Startup

1. Initializes taco-web (`@nucypher/taco`)
2. Creates RPC providers and bundler/paymaster clients
3. **Pre-fetches** the signing condition from the on-chain contract — this is cached and reused for all requests, avoiding an RPC call per request

### Payload Preparation (done once)

For each payload in the config, the tool pre-computes everything expensive:

1. Derives the sender's smart account address (RPC calls to get cohort multisig, participants, threshold)
2. Derives the recipient's smart account address
3. Builds the ERC-20 transfer calldata
4. Prepares the UserOperation via the bundler (nonce, gas estimates)
5. Builds the signing context from the cached condition

### Request Execution

Each signing request:

1. Creates a fresh `ConditionContext` from the cached condition (no RPC)
2. Calls `signUserOp` which internally:
   - Fetches Porter URIs (network call to GitHub)
   - Fetches participants and threshold (2 RPC calls)
   - Builds signing requests (local crypto)
   - Sends to Porter → TACo nodes (the slow part, ~6-15s)
   - Decrypts and aggregates the response (local crypto)
3. Returns timing data for each stage

### Rate Control

- **Steady mode**: Fires a new request every `60000/rate` ms, regardless of in-flight count
- **Burst mode**: Fires N requests simultaneously, waits for all, then fires next batch
- **Cooldown**: Between test phases, a countdown timer shows remaining time

## Tips

- **Start small**: Run at 10 requests/min first to establish a baseline before going higher.
- **Use cooldown**: The default 120s cooldown between phases lets the TACo nodes recover. Reduce it if you want to stress harder, increase it for cleaner isolated results.
- **Multiple payloads**: Adding more payloads to your config means more variety in the test, though results should be similar since the signing condition is the same.
- **RPC speed matters**: We found public RPCs (publicnode, drpc) are 3x faster than Infura for Base Sepolia. The `rpc` timing in the output will tell you if your endpoints are slow.
- **Kill safely**: Ctrl+C will stop the test. Data for completed requests is not saved if you interrupt — let each phase finish naturally.
