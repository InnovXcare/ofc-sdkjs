"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SEARCH_ROOTS = ["word", "cell", "slide", "pdf", "common"];
const EXCLUDED_PARTS = new Set([
	"deploy",
	"vendor",
	"node_modules",
	"build/node_modules",
	"tests",
	"test"
]);
const LOOKAHEAD_LINES = 6;

function shouldSkip(relativePath) {
	return relativePath.split(path.sep).some((part, index, parts) => {
		if (EXCLUDED_PARTS.has(part))
			return true;

		// Skip generated/minified assets that are not practical audit targets.
		if (index === parts.length - 1 && (part.endsWith(".min.js") || part === "sdk-all.js"))
			return true;

		return false;
	});
}

function walk(dirPath, relativeBase, result) {
	for (const entry of fs.readdirSync(dirPath, {withFileTypes: true})) {
		const absPath = path.join(dirPath, entry.name);
		const relPath = path.join(relativeBase, entry.name);

		if (shouldSkip(relPath))
			continue;

		if (entry.isDirectory()) {
			walk(absPath, relPath, result);
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".js"))
			result.push({absPath, relPath});
	}
}

function collectFiles() {
	const files = [];
	for (const root of SEARCH_ROOTS) {
		const absRoot = path.join(ROOT, root);
		if (fs.existsSync(absRoot))
			walk(absRoot, root, files);
	}
	return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function hasFunctionGuard(lines, start, end, objectName, methodName) {
	const guardRegex = new RegExp(
		`typeof\\s+${objectName.replace(/\$/g, "\\$")}\\.${methodName}\\s*={2,3}\\s*["']function["']`
	);
	for (let index = start; index <= end; ++index) {
		if (guardRegex.test(lines[index]))
			return true;
	}
	return false;
}

function findFindings(file) {
	const text = fs.readFileSync(file.absPath, "utf8");
	const lines = text.split(/\r?\n/);
	const findings = [];

	for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
		const line = lines[lineIndex];

		const directMatch = line.match(/AscCommon\.g_oTableId\.Get_ById\([^)]*\)\.([A-Za-z_$][\w$]*)\s*\(/);
		if (directMatch) {
			findings.push({
				type: "direct-call",
				file: file.relPath,
				line: lineIndex + 1,
				method: directMatch[1],
				snippet: line.trim()
			});
		}

		const assignMatch = line.match(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*AscCommon\.g_oTableId\.Get_ById\([^;]*\)/);
		if (!assignMatch)
			continue;

		const objectName = assignMatch[1];
		const maxLine = Math.min(lines.length - 1, lineIndex + LOOKAHEAD_LINES);
		for (let lookahead = lineIndex + 1; lookahead <= maxLine; ++lookahead) {
			const usageMatch = lines[lookahead].match(new RegExp(`\\b${objectName.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`));
			if (!usageMatch)
				continue;

			const methodName = usageMatch[1];
			if (hasFunctionGuard(lines, lineIndex, lookahead, objectName, methodName))
				continue;

			findings.push({
				type: "lookup-then-call",
				file: file.relPath,
				line: lookahead + 1,
				assignedAt: lineIndex + 1,
				objectName,
				method: methodName,
				snippet: lines[lookahead].trim()
			});
		}
	}

	return findings;
}

function main() {
	const files = collectFiles();
	const findings = [];

	for (const file of files)
		findings.push(...findFindings(file));

	findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

	for (const finding of findings) {
		if (finding.type === "direct-call") {
			console.log(`${finding.file}:${finding.line} [direct-call] .${finding.method}()`);
		} else {
			console.log(
				`${finding.file}:${finding.line} [lookup-then-call] ${finding.objectName}.${finding.method}()` +
				` assigned at line ${finding.assignedAt}`
			);
		}
		console.log(`  ${finding.snippet}`);
	}

	console.log("");
	console.log(`Scanned ${files.length} files, found ${findings.length} potential unguarded TableId method calls.`);
	process.exitCode = findings.length > 0 ? 1 : 0;
}

main();
