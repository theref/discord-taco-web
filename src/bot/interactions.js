const http = require("node:http");
const https = require("node:https");
const nacl = require("tweetnacl");
const { spawn } = require("node:child_process");
const path = require("node:path");
require("dotenv").config();

let running = false;

// Discord epoch: January 1, 2015 00:00:00 UTC (in milliseconds)
const DISCORD_EPOCH = 1420070400000n;

// Minimum account age in days (configurable via env)
const MIN_ACCOUNT_AGE_DAYS = Number(process.env.MIN_ACCOUNT_AGE_DAYS || 7);

/**
 * Extract creation timestamp from Discord snowflake ID.
 * Discord snowflakes encode timestamp in bits 22-63.
 * Formula: (snowflake >> 22) + DISCORD_EPOCH = Unix timestamp (ms)
 */
function getDiscordAccountCreationTime(snowflakeId) {
  const snowflake = BigInt(snowflakeId);
  const timestamp = Number((snowflake >> 22n) + DISCORD_EPOCH);
  return new Date(timestamp);
}

/**
 * Calculate account age in days from Discord user ID.
 */
function getAccountAgeDays(snowflakeId) {
  const createdAt = getDiscordAccountCreationTime(snowflakeId);
  const now = new Date();
  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs / (1000 * 60 * 60 * 24);
}

/**
 * Check if Discord account meets minimum age requirement.
 * Returns { valid: boolean, ageDays: number, minDays: number }
 */
function checkAccountAge(snowflakeId) {
  const ageDays = getAccountAgeDays(snowflakeId);
  return {
    valid: ageDays >= MIN_ACCOUNT_AGE_DAYS,
    ageDays: Math.floor(ageDays),
    minDays: MIN_ACCOUNT_AGE_DAYS,
  };
}

function sendFollowup(applicationId, interactionToken, content) {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`;
  const body = JSON.stringify({ content });

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, data }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function startDemo(envOverrides, onComplete) {
  if (running) return null;
  running = true;
  const projectRoot = path.resolve(__dirname, "..", "..");

  let stdout = "";
  let stderr = "";

  const child = spawn("pnpm", ["start"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    const text = data.toString();
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (data) => {
    const text = data.toString();
    stderr += text;
    process.stderr.write(text);
  });

  child.on("close", (code) => {
    running = false;
    onComplete({ code, stdout, stderr });
  });

  child.on("error", (err) => {
    running = false;
    onComplete({ code: 1, stdout, stderr: err.message });
  });

  return child;
}

function createServer() {
  const port = Number(
    process.env.PORT || process.env.INTERACTIONS_PORT || 8787,
  );
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      if (!(req.method === "POST" && req.url === "/interactions")) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      console.log("➡️  POST /interactions");
      const sig = req.headers["x-signature-ed25519"];
      const ts = req.headers["x-signature-timestamp"];
      console.log("   headers:", {
        "x-signature-ed25519": sig ? "<present>" : "<missing>",
        "x-signature-timestamp": ts ? "<present>" : "<missing>",
        "content-type": req.headers["content-type"],
      });

      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks);
      console.log("   bodyBytes:", rawBody.length);

      const pubKeyHex = process.env.DISCORD_PUBLIC_KEY;
      if (!pubKeyHex) {
        res.writeHead(500);
        res.end("Missing DISCORD_PUBLIC_KEY");
        return;
      }
      if (!sig || !ts) {
        res.writeHead(401);
        res.end("Missing Discord signature headers");
        return;
      }
      const ok = nacl.sign.detached.verify(
        Buffer.concat([Buffer.from(String(ts), "utf8"), rawBody]),
        Buffer.from(String(sig).replace(/^0x/, ""), "hex"),
        Buffer.from(pubKeyHex.replace(/^0x/, ""), "hex"),
      );
      if (!ok) {
        res.writeHead(401);
        res.end("Invalid Discord signature");
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }

      // Handle ping
      if (parsed?.type === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: 1 }));
        return;
      }

      // Extract interaction details for follow-up
      const applicationId = parsed?.application_id;
      const interactionToken = parsed?.token;

      // Extract sender Discord user ID for account age check
      const senderUserId = parsed?.member?.user?.id;
      if (senderUserId) {
        const ageCheck = checkAccountAge(senderUserId);
        if (!ageCheck.valid) {
          console.log(
            `   ✗ Account too new: ${ageCheck.ageDays} days (min: ${ageCheck.minDays})`,
          );
          // Respond with immediate error (type 4 = CHANNEL_MESSAGE_WITH_SOURCE)
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: 4,
              data: {
                content: `Your Discord account must be at least ${ageCheck.minDays} days old to send tips. Your account is ${ageCheck.ageDays} days old.`,
                flags: 64, // Ephemeral - only visible to sender
              },
            }),
          );
          return;
        }
        console.log(`   ✓ Account age OK: ${ageCheck.ageDays} days`);
      }

      // Extract tip parameters from Discord payload (nested execute subcommand)
      let amount = process.env.TIP_AMOUNT_ETH || "0.0001";
      let recipientUserId = "";
      let tokenType = "ETH";
      const executeCmd = parsed?.data?.options?.find(
        (o) => o?.name === "execute",
      );
      const options = executeCmd?.options || [];
      const amountOpt = options.find((o) => o?.name === "amount")?.value;
      const recipientOpt = options.find((o) => o?.name === "receiver")?.value;
      const tokenOpt = options.find((o) => o?.name === "token")?.value;
      if (amountOpt != null) amount = String(amountOpt);
      if (recipientOpt) recipientUserId = String(recipientOpt);
      if (tokenOpt) tokenType = String(tokenOpt);

      const envOverrides = {
        CONTEXT_TIMESTAMP: String(ts),
        CONTEXT_SIGNATURE_HEX: String(sig).replace(/^0x/, ""),
        CONTEXT_DISCORD_PAYLOAD: rawBody.toString("utf8"),
        TIP_AMOUNT_ETH: amount,
        TIP_RECIPIENT_USER_ID: recipientUserId,
        TIP_TOKEN_TYPE: tokenType,
      };
      console.log("   ✓ Overrides:", {
        CONTEXT_TIMESTAMP: String(ts),
        CONTEXT_SIGNATURE_HEX: `${String(sig).slice(0, 18)}...`,
        TIP_AMOUNT_ETH: amount,
        TIP_RECIPIENT_USER_ID: recipientUserId,
        TIP_TOKEN_TYPE: tokenType,
      });

      // Respond with deferred message (type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: 5 }));

      // Start demo and send follow-up when complete
      const child = startDemo(envOverrides, async ({ code, stdout }) => {
        let message;

        if (code === 0) {
          // Parse SUCCESS JSON from output
          const successMatch = stdout.match(/SUCCESS:(\{.*\})/);
          if (successMatch) {
            try {
              const data = JSON.parse(successMatch[1]);
              const shortenAddr = (addr) =>
                `${addr.slice(0, 10)}...${addr.slice(-8)}`;
              const tacoTime = data.tacoSigningMs
                ? `${(data.tacoSigningMs / 1000).toFixed(2)}s`
                : "N/A";
              const gasUsedStr = data.gasUsed
                ? BigInt(data.gasUsed).toLocaleString()
                : "N/A";
              const estCostStr =
                data.estMainnetCostUsd && data.estMainnetCostUsd !== "N/A"
                  ? `$${data.estMainnetCostUsd}`
                  : "N/A";

              message =
                `**Tip Sent!**\n` +
                `> **From:** \`${shortenAddr(data.from)}\` (<@${data.fromDiscord}>)\n` +
                `> **To:** \`${shortenAddr(data.to)}\` (<@${data.toDiscord}>)\n` +
                `> **Amount:** ${data.netAmount} ${data.token} (+ ${data.feeAmount} ${data.token} fee)\n` +
                `> **Chain:** ${data.chainName}\n` +
                `> **TACo:** ${tacoTime}\n` +
                `> **Gas Used:** ${gasUsedStr}\n` +
                `> **Est. Mainnet Cost:** ${estCostStr}\n\n` +
                `<${data.explorerUrl}>`;
            } catch {
              // Fallback if JSON parsing fails
              message = `Tip sent! [View transaction](https://sepolia.basescan.org)`;
            }
          } else {
            message = `Tip sent successfully!`;
          }
        } else {
          // Extract error from output
          const errorMatch = stdout.match(/Demo failed: (.+)/);
          const error = errorMatch ? errorMatch[1] : "Unknown error";
          message = `**Tip Failed**\n> ${error}`;
        }

        if (applicationId && interactionToken) {
          try {
            await sendFollowup(applicationId, interactionToken, message);
            console.log("   ✓ Follow-up sent:", message);
          } catch (err) {
            console.error("   ✗ Follow-up failed:", err.message);
          }
        }
      });

      if (!child) {
        // Demo already running - edit the deferred response
        if (applicationId && interactionToken) {
          await sendFollowup(
            applicationId,
            interactionToken,
            "A tip is already being processed. Please wait.",
          );
        }
      }
    } catch (e) {
      console.error("Error:", e);
      res.writeHead(500);
      res.end((e && e.message) || "error");
    }
  });
  server.listen(port, () => {
    console.log(
      `Discord interactions server listening on :${port}/interactions`,
    );
  });
}

module.exports = { createServer };
