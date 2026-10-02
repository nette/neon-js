// Helpers shared by the examples.


/** Removes the common indentation and the first and last line break of a template, like a heredoc. */
export function sample(text: string): string {
	const lines = text.replace(/^\n/, '').replace(/\n[\t ]*$/, '').split('\n');
	const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^\t*/.exec(line)![0].length));
	return lines.map((line) => line.slice(indent)).join('\n') + '\n';
}
