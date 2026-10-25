import { runAudit } from "./runner.js";

// This entry point is spawned with explicit Node arguments and an allowlisted environment.
// Never import it into the HTTP server: parsing and serialization belong off its event loop.
try {
  const repo = process.argv[2];
  const maxBytes = Number(process.argv[3]);
  const report = await runAudit(repo, { codemod: "diff" });
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized) > maxBytes) process.exitCode = 2;
  else process.stdout.write(serialized);
} catch {
  // Clone errors can contain paths or credentials. Only expose a generic failure to HTTP.
  process.exitCode = 1;
}
