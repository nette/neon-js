/**
 * neon-lint: findings with positions, a verdict in the exit code, JSON for tools.
 * Here it runs from code over files of a temporary directory; on the command line it is
 * `npx neon-lint config/`.
 *
 * Usage: npx tsx examples/linting/lint.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';

const dir = mkdtempSync(join(tmpdir(), 'neon-lint-example-'));
mkdirSync(join(dir, 'config'));
writeFileSync(join(dir, 'config', 'common.neon'), 'database:\n\tdsn: sqlite:db.sqlite\n');
writeFileSync(join(dir, 'config', 'local.neon'), 'database:\n\tuser: root\n\tuser: admin\n');
writeFileSync(join(dir, 'config', 'services.neon'), 'services:\n\t- App\\Mailer(\n');
process.chdir(dir);

const io = { out: (text: string) => process.stdout.write(text), err: (text: string) => process.stdout.write(text), stdin: () => Buffer.from('') };
const run = (args: string[]) => {
	console.log(`$ neon-lint ${args.join(' ')}`);
	console.log(`exit code ${main(args, io)}\n`);
};

run(['config']);
run(['--json', 'config/local.neon']);
run(['--verbose', 'config/common.neon']);

process.chdir(tmpdir());
rmSync(dir, { recursive: true, force: true });
