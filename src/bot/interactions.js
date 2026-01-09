const http = require("node:http");
const https = require("node:https");
const nacl = require("tweetnacl");
const { spawn } = require("node:child_process");
const path = require("node:path");
require("dotenv").config();

let running = false;

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
        // Extract TACo signing time from output
        const signingTimeMatch = stdout.match(/TACO_SIGNING_TIME_MS:(\d+)/);
        const signingTimeMs = signingTimeMatch ? signingTimeMatch[1] : null;
        const signingTimeStr = signingTimeMs
          ? ` (TACo signing: ${(signingTimeMs / 1000).toFixed(2)}s)`
          : "";

        if (code === 0) {
          // Extract tx hash from output
          const txMatch = stdout.match(/Tx: (0x[a-fA-F0-9]+)/);
          const txHash = txMatch ? txMatch[1] : null;
          if (txHash) {
            message = `Tip sent!${signingTimeStr} [View on BaseScan](https://sepolia.basescan.org/tx/${txHash})`;
          } else {
            message = `Tip sent successfully!${signingTimeStr}`;
          }
        } else {
          // Extract error from output
          const errorMatch = stdout.match(/Demo failed: (.+)/);
          const error = errorMatch ? errorMatch[1] : "Unknown error";
          message = `Tip failed: ${error}${signingTimeStr}`;
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
