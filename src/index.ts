import { buildCli } from './cli/cli.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // No args + interactive TTY → launch TUI
  if (argv.length === 0 && process.stdout.isTTY) {
    const { runTui } = await import('./cli/tui.js');
    runTui();
    return;
  }

  const program = buildCli();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
