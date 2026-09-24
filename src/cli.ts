// The command line linter. Uses Node; the rest of the package does not.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { NeonError } from './errors.ts';
import { parse } from './parser.ts';
import { Cursor } from './position.ts';
import { decodeUtf8 } from './utf8.ts';


interface Finding {
	path: string;
	line: number | null;
	column: number | null;
	message: string;
}

export interface Io {
	out(text: string): void;
	err(text: string): void;
	stdin(): Uint8Array;
}

const Usage = `Usage: neon-lint [options] <path>...

Checks NEON files; a path is a file, a directory (searched for *.neon) or - for stdin.

Options:
  --check     also verify that printing the parsed tree gives back the file
  --json      print the findings as JSON
  --quiet     print nothing, only set the exit code
  --verbose   print the number of files when all are valid
`;

const SkippedDirectories = new Set(['vendor', 'node_modules', '.git']);


/** Runs the linter and returns the exit code. */
export function main(args: string[], io: Io = nodeIo): number {
	const options = new Set(args.filter((arg) => arg.startsWith('--')));
	const paths = args.filter((arg) => !arg.startsWith('--'));
	const known = ['--check', '--json', '--quiet', '--verbose', '--help'];
	const unknown = [...options].find((option) => !known.includes(option));
	if (options.has('--help')) {
		io.out(Usage);
		return 0;
	} else if (unknown || !paths.length) {
		io.err((unknown ? `Unknown option ${unknown}\n\n` : '') + Usage);
		return 2;
	}

	const { files, findings } = collect(paths);

	if (!files.length && !findings.length) {
		findings.push({ path: paths.join(' '), line: null, column: null, message: 'No file found' });
	}
	for (const file of files) {
		try {
			const finding = lintFile(file, options.has('--check'), io);
			if (finding) {
				findings.push(finding);
			}
		} catch (e) {
			return internalError(file, e, io);
		}
	}

	findings.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	if (options.has('--quiet')) {
		// nothing
	} else if (options.has('--json')) {
		io.out(JSON.stringify(findings) + '\n');
	} else if (findings.length) {
		io.out(findings.map(formatFinding).join('\n') + '\n');
	} else if (options.has('--verbose')) {
		io.out(`OK ${files.length} files\n`);
	}
	return findings.length ? 1 : 0;
}


function formatFinding(f: Finding): string {
	return f.line === null ? `${f.path}: ${f.message}` : `${f.path}:${f.line}:${f.column}: ${f.message}`;
}


function internalError(path: string, e: unknown, io: Io): number {
	io.err(`Internal error in ${path}: ${e instanceof Error ? e.message : e}\nPlease report it at https://github.com/nette/neon-js/issues\n`);
	return 2;
}


/** The text of a file, or the finding why it cannot be read. */
function read(path: string, io: Io): string | Finding {
	try {
		return decodeUtf8(path === '-' ? io.stdin() : readFileSync(path));
	} catch (e) {
		if (e instanceof NeonError) {
			return { path, line: e.position!.line, column: e.position!.column, message: e.message };
		}
		return { path, line: null, column: null, message: e instanceof Error ? e.message : String(e) };
	}
}


function lintFile(path: string, check: boolean, io: Io): Finding | null {
	const input = read(path, io);
	if (typeof input !== 'string') {
		return input;
	}

	try {
		const document = parse(input);
		if (check) {
			const printed = document.print();
			if (printed !== input) {
				let i = 0;
				while (printed[i] === input[i]) {
					i++;
				}
				const position = new Cursor(input).at(i);
				return { path, line: position.line, column: position.column, message: 'Printing the tree differs from the file' };
			}
		}
	} catch (e) {
		if (e instanceof NeonError && e.position) {
			return { path, line: e.position.line, column: e.position.column, message: e.message };
		}
		throw e;
	}
	return null;
}


/**
 * The files to lint, sorted by path, each once even when two paths name it; a path given that does not
 * exist, or a directory that cannot be read, is a finding. The recursion does not follow links, a path
 * given is followed.
 */
function collect(paths: string[]): { files: string[]; findings: Finding[] } {
	const files = (new Map<string, string>); // identity of the file => the path shown
	const findings: Finding[] = [];
	const add = (path: string) => {
		let identity = path;
		try {
			identity = path === '-' ? path : realpathSync.native(path);
		} catch {
			// the path itself
		}
		if (!files.has(identity)) {
			files.set(identity, path);
		}
	};
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (e) {
			findings.push({ path: dir, line: null, column: null, message: e instanceof Error ? e.message : String(e) });
			return;
		}
		for (const entry of entries) {
			const full = dir.replace(/[\\/]+$/, '') + '/' + entry; // the same output on every system
			const stat = lstatSync(full, { throwIfNoEntry: false });
			if (!stat || stat.isSymbolicLink() || entry.startsWith('.') || SkippedDirectories.has(entry)) {
				continue;
			} else if (stat.isDirectory()) {
				walk(full);
			} else if (entry.endsWith('.neon')) {
				add(full);
			}
		}
	};

	for (const path of paths) {
		const stat = path === '-' ? null : statSync(path, { throwIfNoEntry: false });
		if (path === '-' || stat?.isFile()) {
			add(path);
		} else if (stat?.isDirectory()) {
			walk(path);
		} else {
			findings.push({ path, line: null, column: null, message: stat ? 'Not a file or a directory' : 'No file found' });
		}
	}
	return {
		files: [...files.values()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
		findings,
	};
}


const nodeIo: Io = {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	stdin: () => readFileSync(0),
};
