import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';


export const corpusDir = resolve(process.env.NEON_CORPUS ?? join(import.meta.dirname, 'neon-spec', 'corpus'));

/** The version of the specification this implementation follows. */
const SpecVersion = '1.1.0';

/** The corpus belongs to a checkout of the specification of the version this implementation follows. */
function checkVersion(root: string): void {
	const file = join(root, '..', 'spec', 'VERSION');
	if (!existsSync(file)) {
		throw new Error(`Missing ${file}; the corpus belongs to a checkout of the specification.`);
	} else if (readFileSync(file, 'utf8').trim() !== SpecVersion) {
		throw new Error(`The corpus is of specification ${readFileSync(file, 'utf8').trim()}, this implementation follows ${SpecVersion}.`);
	}
}

export interface CaseMeta {
	schema: 1;
	hosts?: string[];
	php3?: 'fixed' | 'host';
	reason?: string;
	indentation?: string;
	blockMode?: boolean | number;
}

export interface Case {
	name: string;
	base: string;
	meta: CaseMeta;
	read(ext: string): string | null;
	readBytes(ext: string): Buffer | null;
}


/** The files of a case in each category: the input, the required expectations, all allowed ones. */
const Categories: Record<string, { input: string; required: string[][]; allowed: RegExp }> = {
	decode: { input: '.neon', required: [['.json']], allowed: /^\.json$/ },
	errors: { input: '.neon', required: [['.error']], allowed: /^\.error$/ },
	encode: { input: '.json', required: [['.neon', '.error']], allowed: /^\.(?:neon|block\.neon|error)$/ },
	cst: { input: '.neon', required: [['.dump']], allowed: /^\.dump$/ },
	roundtrip: { input: '.neon', required: [['.dump']], allowed: /^\.dump$/ },
	mutations: { input: '.neon', required: [['.ops.json'], ['.expected.neon']], allowed: /^\.(?:ops\.json|expected(?:\.\d+)?\.(?:neon|json))$/ },
};

const Hosts = ['js', 'php', 'py'];


/** Cases of a category, found by their input file. The corpus is validated strictly: anything unknown is a failure. */
export function loadCases(category: string, root = corpusDir): Case[] {
	checkVersion(root);
	const spec = Categories[category];
	const dir = join(root, category);
	if (!spec) {
		throw new Error(`Unknown category ${category}`);
	} else if (!existsSync(dir)) {
		throw new Error(`Missing category ${dir}; is the submodule checked out?`);
	}

	const files = readdirSync(dir);
	const names = files.filter((file) => /^[^.]+/.exec(file)![0] + spec.input === file).map((file) => file.slice(0, -spec.input.length)).sort();
	if (!names.length) {
		throw new Error(`Empty category ${dir}`);
	}
	for (const file of files) {
		const name = /^[^.]+/.exec(file)![0];
		const ext = file.slice(name.length);
		if (ext !== spec.input && ext !== '.case.json' && !spec.allowed.test(ext)) {
			throw new Error(`Unknown file ${join(dir, file)}`);
		} else if (!names.includes(name)) {
			throw new Error(`An expectation without its input: ${join(dir, file)}`);
		}
	}

	return names.map((name) => {
		const base = join(dir, name);
		for (const group of spec.required) {
			if (!group.some((ext) => existsSync(base + ext))) {
				throw new Error(`Missing ${group.join(' or ')} of ${base}`);
			}
		}
		const meta = readMeta(base + '.case.json', category);
		return {
			name,
			base,
			meta,
			read: (ext: string) => existsSync(base + ext) ? readFileSync(base + ext, 'utf8') : null,
			readBytes: (ext: string) => existsSync(base + ext) ? readFileSync(base + ext) : null,
		};
	});
}


/** The sidecar of a case, checked field by field; an `open` deviation of 3.x fails the run. */
function readMeta(file: string, category: string): CaseMeta {
	if (!existsSync(file)) {
		return { schema: 1 };
	}
	const meta = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	const fail = (message: string) => {
		throw new Error(`${message} in ${file}`);
	};
	for (const key of Object.keys(meta)) {
		if (!['schema', 'hosts', 'php3', 'reason', 'indentation', 'blockMode'].includes(key)) {
			fail(`Unknown field '${key}'`);
		}
	}
	if (meta.schema !== 1) {
		fail('Unknown schema');
	} else if (meta.hosts !== undefined && (!Array.isArray(meta.hosts) || !meta.hosts.length || !meta.hosts.every((host) => Hosts.includes(host as string)))) {
		fail('Invalid hosts');
	} else if (meta.php3 === 'open') {
		fail('An open deviation from nette/neon 3.x');
	} else if (meta.php3 !== undefined && meta.php3 !== 'fixed' && meta.php3 !== 'host') {
		fail('Invalid php3');
	} else if ((meta.hosts || meta.php3) && (typeof meta.reason !== 'string' || !meta.reason.trim())) {
		fail('A sidecar without reason');
	} else if (meta.reason !== undefined && typeof meta.reason !== 'string') {
		fail('Invalid reason');
	} else if (meta.indentation !== undefined && (typeof meta.indentation !== 'string' || !/^[\t ]+$/.test(meta.indentation) || category !== 'encode')) {
		fail('Invalid indentation');
	} else if (meta.blockMode !== undefined && ((typeof meta.blockMode !== 'boolean' && !(Number.isInteger(meta.blockMode) && (meta.blockMode as number) >= 0)) || category !== 'encode')) {
		fail('Invalid blockMode');
	}
	return meta as unknown as CaseMeta;
}


/** Whether the case runs in this host. */
export function runsHere(c: Case): boolean {
	return !c.meta.hosts || c.meta.hosts.includes('js');
}


/** All .neon files below a directory, for the external corpus. */
export function findNeonFiles(dir: string): string[] {
	const res: string[] = [];
	const walk = (path: string) => {
		for (const entry of readdirSync(path)) {
			if (entry === 'vendor' || entry === 'node_modules' || entry.startsWith('.')) {
				continue;
			}
			const full = join(path, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				walk(full);
			} else if (entry.endsWith('.neon')) {
				res.push(full);
			}
		}
	};
	walk(dir);
	return res.sort();
}
