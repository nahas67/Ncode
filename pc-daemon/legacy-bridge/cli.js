#!/usr/bin/env node

const args = process.argv.slice(2);

if (args[0] === 'start') {
  // Start the MCP server
  import('./server.js').catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
} else {
  // ── Setup wizard ──────────────────────────────────────────
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║        gemini-browser-mcp Setup             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // For now, only Claude Code is supported
  console.log('Which CLI would you like to configure?');
  console.log('');
  console.log('  1. Claude Code  (default)');
  console.log('');
  console.log('  GitHub: https://github.com/Walkoud/gemini-browser-mcp');
  console.log('');
  console.log('→ Configuring Claude Code...');

  const { execSync } = await import('child_process');

  try {
    execSync(
      'claude mcp add gemini-browser-mcp -- npx gemini-browser-mcp start',
      { stdio: 'inherit', timeout: 30000 }
    );

    console.log('');
    console.log('  ✓ Claude Code configured successfully!');
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Download the Chrome extension:');
    console.log('       https://github.com/Walkoud/gemini-browser-mcp');
    console.log('    2. Load it in Chrome at chrome://extensions/ (as unpacked)');
    console.log('    3. Open https://gemini.google.com and log in');
    console.log('    4. Restart Claude Code');
    console.log('');
  } catch (err) {
    console.error('');
    console.error('  ✗ Failed to configure Claude Code automatically.');
    console.error('    Make sure Claude Code is installed, or run manually:');
    console.error('');
    console.error('    claude mcp add gemini-browser-mcp -- npx gemini-browser-mcp start');
    console.error('');
    console.error('    Need the Chrome extension? Get it here:');
    console.error('    https://github.com/Walkoud/gemini-browser-mcp');
    console.error('');
  }
}
