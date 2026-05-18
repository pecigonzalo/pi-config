import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type PackageJson = {
	scripts?: Record<string, string>;
};

const extensionsDir = join(process.cwd(), "agent", "extensions");

function hasTestFiles(dir: string): boolean {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory() && hasTestFiles(path)) return true;
		if (stat.isFile() && entry.endsWith(".test.ts")) return true;
	}
	return false;
}

function packageTestScript(dir: string): string | undefined {
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
	return packageJson.scripts?.test;
}

const extensionDirs = readdirSync(extensionsDir)
	.map((entry) => join(extensionsDir, entry))
	.filter((path) => statSync(path).isDirectory())
	.filter(hasTestFiles)
	.sort();

if (extensionDirs.length === 0) {
	console.log("No extension tests found.");
	process.exit(0);
}

for (const dir of extensionDirs) {
	const name = dir.slice(extensionsDir.length + 1);
	const hasPackageTest = packageTestScript(dir) !== undefined;
	const args = hasPackageTest ? ["run", "test"] : ["test"];

	console.log(`\n=== ${name}: bun ${args.join(" ")} ===`);
	const result = spawnSync("bun", args, {
		cwd: dir,
		stdio: "inherit",
		env: process.env,
	});

	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
