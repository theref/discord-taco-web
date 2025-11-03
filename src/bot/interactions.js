const http = require('node:http');
const nacl = require('tweetnacl');
const { spawn } = require('node:child_process');
const path = require('node:path');
require('dotenv').config();

let running = false;

function startDemo(envOverrides = {}) {
  if (running) return null;
  running = true;
  const demoRoot = path.resolve(__dirname, '..', '..');
  const child = spawn('pnpm', ['start'], {
    cwd: demoRoot,
    env: {
      ...process.env,
      // Ensure the demo process resolves workspace links (new TACo schema)
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--preserve-symlinks',
      // Work around wasm loader issues in Node by forcing JS JSONPath engine
      JSONPATH_NO_WASM: process.env.JSONPATH_NO_WASM || '1',
      JSONPATH_ENGINE: process.env.JSONPATH_ENGINE || 'js',
      JSONPATH_DISABLE_WASM: process.env.JSONPATH_DISABLE_WASM || '1',
      ASTRONAUTLABS_JSONPATH_ENGINE: process.env.ASTRONAUTLABS_JSONPATH_ENGINE || 'js',
      ...envOverrides,
    },
    stdio: 'inherit',
  });
  child.on('close', () => {
    running = false;
  });
  child.on('error', () => {
    running = false;
  });
  return child;
}

function createServer() {
  const port = Number(process.env.PORT || process.env.INTERACTIONS_PORT || 8787);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200); res.end('ok'); return;
      }
      if (!(req.method === 'POST' && req.url === '/interactions')) {
        res.writeHead(404); res.end('not found'); return;
      }
      console.log('➡️  POST /interactions');
      const sig = req.headers['x-signature-ed25519'];
      const ts  = req.headers['x-signature-timestamp'];
      console.log('   headers:', {
        'x-signature-ed25519': sig ? '<present>' : '<missing>',
        'x-signature-timestamp': ts ? '<present>' : '<missing>',
        'content-type': req.headers['content-type'],
      });

      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks);
      console.log('   bodyBytes:', rawBody.length);

      const pubKeyHex = process.env.DISCORD_PUBLIC_KEY;
      if (!pubKeyHex) { res.writeHead(500); res.end('Missing DISCORD_PUBLIC_KEY'); return; }
      if (!sig || !ts) { res.writeHead(401); res.end('Missing Discord signature headers'); return; }
      const ok = nacl.sign.detached.verify(
        Buffer.concat([Buffer.from(String(ts), 'utf8'), rawBody]),
        Buffer.from(String(sig).replace(/^0x/, ''), 'hex'),
        Buffer.from(pubKeyHex.replace(/^0x/, ''), 'hex'),
      );
      if (!ok) { res.writeHead(401); res.end('Invalid Discord signature'); return; }

      const messageHex = '0x' + Buffer.concat([Buffer.from(String(ts),'utf8'), rawBody]).toString('hex');

      // Normalize payload for cohort JSONPath
      let amount = process.env.TIP_AMOUNT_ETH || '0.0001';
      let recipient = process.env.TIP_RECIPIENT || '';
      try {
        const json = JSON.parse(rawBody.toString('utf8'));
        const options = json?.data?.options || [];
        const amountOpt = options.find((o) => o?.name === 'amount')?.value;
        const recipientOpt = options.find((o) => o?.name === 'recipient')?.value;
        if (amountOpt != null) amount = String(amountOpt);
        if (recipientOpt) recipient = String(recipientOpt);
      } catch {}
      const normalizedPayload = JSON.stringify({
        data: { options: [ { name: 'amount', value: Number(amount) }, { name: 'recipient', value: String(recipient) } ] },
      });

      const envOverrides = {
        CONTEXT_MESSAGE_HEX: messageHex,
        CONTEXT_SIGNATURE_HEX: String(sig).replace(/^0x/, ''),
        CONTEXT_DISCORD_PAYLOAD: rawBody.toString('utf8'),
        TIP_AMOUNT_ETH: amount,
        TIP_RECIPIENT: recipient,
      };
      console.log('   ✓ Overrides:', {
        CONTEXT_MESSAGE_HEX: `${messageHex.slice(0, 18)}...`,
        CONTEXT_SIGNATURE_HEX: `${String(sig).slice(0, 18)}...`,
        CONTEXT_DISCORD_PAYLOAD: '<raw discord body>',
        TIP_AMOUNT_ETH: amount,
        TIP_RECIPIENT: recipient,
      });

      const child = startDemo(envOverrides);
      if (!child) { res.writeHead(429); res.end('Demo already running'); return; }

      try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        if (parsed?.type === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 1 })); return;
        }
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 4, data: { content: 'Processing tip…' } }));
    } catch (e) {
      res.writeHead(500); res.end((e && e.message) || 'error');
    }
  });
  server.listen(port, () => {
    console.log(`🛰️  Discord interactions server listening on :${port}/interactions`);
  });
}

module.exports = { createServer };


