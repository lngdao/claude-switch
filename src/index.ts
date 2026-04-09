import { buildCli } from './cli/cli.js';
import { maybePromptForUpdate } from './core/update-check.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Auto-update prompt (oh-my-zsh style): if a cached newer version exists
  // and we're interactive, ask the user. If they say yes, this function
  // installs and exits — never returns.
  await maybePromptForUpdate(argv);

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
