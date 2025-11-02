const { spawn } = require('node:child_process');
const path = require('node:path');

let running = false;

module.exports = {
  name: 'tip',
  async execute(interaction) {
    try {
      // Single ACK (ephemeral) then only one final edit
      await interaction.deferReply({ flags: 64 }); // 64 = ephemeral

      if (running) {
        await interaction.editReply('Demo is already running. Try again in a moment.');
        return;
      }
      running = true;

      const demoRoot = path.resolve(__dirname, '..', '..');
      const child = spawn('pnpm', ['start'], {
        cwd: demoRoot,
        env: process.env,
        stdio: 'inherit', // stream demo logs directly to server console
      });

      child.on('close', (code) => {
        running = false;
        const msg = code === 0 ? 'Demo completed successfully.' : 'Demo failed. Check server logs.';
        interaction.editReply(msg).catch(() => {});
      });

      child.on('error', (err) => {
        running = false;
        interaction.editReply(`Demo failed to start: ${err.message}`).catch(() => {});
      });
    } catch (err) {
      console.error(err);
      try {
        await interaction.editReply(`Failed to run demo: ${err.message}`);
      } catch {}
    }
  },
};


