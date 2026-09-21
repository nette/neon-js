// Checks out the specification with its corpus into tests/neon-spec, at the commit pinned in tests/neon-spec.lock.
// The repository is the one of NEON_SPEC_REPOSITORY, or GitHub. Usage: npm run spec

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'neon-spec');
const commit = readFileSync(join(import.meta.dirname, 'neon-spec.lock'), 'utf8').trim();
const repository = process.env.NEON_SPEC_REPOSITORY || 'https://github.com/nette/neon-specification.git';
const git = (...args) => execFileSync('git', args, { stdio: 'inherit' });

if (existsSync(join(dir, '.git'))) {
	git('-C', dir, 'fetch', '--quiet', repository);
} else {
	git('clone', '--quiet', '--no-checkout', repository, dir);
}
git('-C', dir, 'checkout', '--quiet', '--detach', commit);
