import { spawnSync } from "node:child_process";

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("npm", ["test"]);
run("node", ["scripts/rendered-workflow.mjs"]);

console.log("\nAcceptance checks passed.");
