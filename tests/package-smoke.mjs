// Installs the packed package into a clean project and uses it as a consumer would: the import, the types
// and the command. Usage: npm run build && node tests/package-smoke.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'neon-package-'));
const npm = (args, cwd) => process.platform === 'win32'
	? execFileSync('cmd.exe', ['/d', '/c', 'npm', ...args], { cwd, encoding: 'utf8' })
	: execFileSync('npm', args, { cwd, encoding: 'utf8' });

try {
	npm(['pack', '--pack-destination', dir], root);
	const tarball = readdirSync(dir).find((file) => file.endsWith('.tgz'));
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
	npm(['install', '--offline', '--no-audit', '--no-fund', join(dir, tarball)], dir);

	writeFileSync(join(dir, 'use.mjs'), [
		'import { decode, encode, parse } from \'@nette/neon\';',
		'const doc = parse(\'a: 1 # c\\n\');',
		'doc.setValue([\'a\'], 2);',
		'if (doc.print() !== \'a: 2 # c\\n\' || encode(decode(\'[1]\')) !== \'[1]\') process.exit(1);',
	].join('\n'));
	execFileSync(process.execPath, ['use.mjs'], { cwd: dir });

	writeFileSync(join(dir, 'use.ts'), [
		'import { parse, type NeonValue } from \'@nette/neon\';',
		'const value: NeonValue = parse(\'a: 1\').toValue();',
		'export { value };',
	].join('\n'));
	writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', target: 'ES2024', strict: true, noEmit: true, types: [] }, files: ['use.ts'] }));
	execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', dir], { cwd: dir, encoding: 'utf8' });

	writeFileSync(join(dir, 'broken.neon'), 'a: [');
	let code = 0;
	try {
		execFileSync(process.execPath, [join(dir, 'node_modules', '@nette', 'neon', 'bin', 'neon-lint.js'), 'broken.neon'], { cwd: dir, encoding: 'utf8' });
	} catch (e) {
		code = e.status;
	}
	if (code !== 1) {
		throw new Error(`neon-lint gave exit code ${code} for a broken file`);
	}
	console.log(`${tarball}: import, types and neon-lint work in a clean project`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
