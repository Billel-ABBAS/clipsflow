import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const runnerName = `clipsflow-shorts-e2e-${suffix}`;
const imageName = `clipsflow-shorts-e2e:${suffix}`;

function run(command, args, options = {}) {
  const { input, allowFailure = false, secretOutput = false } = options;
  const runThroughWindowsCommandShell =
    process.platform === "win32" && command === "pnpm";
  const executable = runThroughWindowsCommandShell
    ? process.env.ComSpec || "cmd.exe"
    : command;
  const executableArgs = runThroughWindowsCommandShell
    ? ["/d", "/s", "/c", `pnpm ${args.join(" ")}`]
    : args;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, executableArgs, {
      cwd: workspace,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0 || allowFailure) {
        resolvePromise({ code: exitCode, output });
        return;
      }
      const detail = secretOutput
        ? "(sensitive command output suppressed)"
        : output.trim();
      reject(
        new Error(
          `${command} ${args[0] ?? ""} failed with exit code ${exitCode}: ${detail}`,
        ),
      );
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length < 2 ||
    !trimmed.startsWith('"') ||
    !trimmed.endsWith('"')
  ) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(1, -1);
  }
}

function parseLocalSupabaseStatus(statusOutput) {
  const values = new Map();
  for (const line of statusOutput.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      values.set(line.slice(0, separator), unquote(line.slice(separator + 1)));
    }
  }

  const apiUrl = values.get("API_URL");
  const anonKey = values.get("ANON_KEY");
  const serviceRoleKey = values.get("SERVICE_ROLE_KEY");
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      "Local Supabase CLI status did not provide its API and keys",
    );
  }

  const parsedUrl = new URL(apiUrl);
  if (
    parsedUrl.protocol !== "http:" ||
    !loopbackHosts.has(parsedUrl.hostname) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      "Refusing to run the Docker E2E against a non-local Supabase project",
    );
  }
  return { apiOrigin: parsedUrl.origin, anonKey, serviceRoleKey };
}

async function discoverSupabaseContainers() {
  const { output } = await run("docker", ["ps", "--format", "{{.Names}}"]);
  const names = output.split(/\r?\n/u).filter(Boolean);
  const kongContainers = names.filter((name) =>
    name.startsWith("supabase_kong_"),
  );
  const databaseContainers = names.filter((name) =>
    name.startsWith("supabase_db_"),
  );
  if (kongContainers.length !== 1 || databaseContainers.length !== 1) {
    throw new Error(
      "Expected exactly one running local Supabase Kong and database",
    );
  }

  const { output: networkOutput } = await run("docker", [
    "inspect",
    "--format",
    "{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}",
    kongContainers[0],
  ]);
  const networks = networkOutput.split(/\r?\n/u).filter(Boolean);
  if (networks.length !== 1) {
    throw new Error("Expected Supabase Kong on exactly one Docker network");
  }
  return {
    kongName: kongContainers[0],
    databaseName: databaseContainers[0],
    network: networks[0],
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createLoopbackRelay(kongName, publicApiOrigin) {
  return [
    "const http=require('http');",
    `const target={hostname:${JSON.stringify(kongName)},port:8000};`,
    `const publicApiOrigin=${JSON.stringify(publicApiOrigin)};`,
    "const relayOrigin='http://127.0.0.1:54321';",
    "http.createServer((req,res)=>{",
    "const upstream=http.request({...target,path:req.url,method:req.method,headers:req.headers},reply=>{const headers={...reply.headers};if(typeof headers.location==='string'){try{const location=new URL(headers.location,publicApiOrigin);if(location.origin===publicApiOrigin){headers.location=relayOrigin+location.pathname+location.search+location.hash}}catch{}}res.writeHead(reply.statusCode||502,headers);reply.pipe(res)});",
    "upstream.on('error',error=>{res.statusCode=502;res.end(error.message)});",
    "req.pipe(upstream)",
    "}).listen(54321,'127.0.0.1');",
  ].join("");
}

async function waitForRunner() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const { output } = await run(
      "docker",
      ["logs", runnerName, "--tail", "80"],
      { allowFailure: true },
    );
    if (output.includes("Ready in")) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("The isolated Next server did not start within 45 seconds");
}

async function startRunner(
  local,
  containers,
  budgetAuthorized,
  analysisWorkerReady = budgetAuthorized,
) {
  const environment = [
    "NODE_ENV=development",
    "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${local.anonKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${local.serviceRoleKey}`,
    "NEXT_PUBLIC_APP_URL=http://127.0.0.1:3104",
    "CLIPSFLOW_ISOLATED_LOCAL_SMOKE=true",
    `CLIPS_AI_BUDGET_AUTHORIZED=${budgetAuthorized ? "true" : "false"}`,
    `SHORTS_ANALYSIS_WORKER_READY=${analysisWorkerReady ? "true" : "false"}`,
    "CLIPS_ELEVENLABS_ENABLED=false",
    "CLIPS_CREATIVE_DIRECTOR_ENABLED=false",
    "CLIPS_JEV_HOOK_SCORE=off",
  ];
  if (budgetAuthorized) {
    environment.push(
      "SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_FREE=7200",
      // Two successful 4-hour modality runs fit; a leaked failed reservation
      // would make the second one exceed this exact local test allowance.
      "SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_STUDIO=28800",
      "OPENAI_API_KEY=local-mock-no-network",
      "GROQ_API_KEY=local-mock-no-network",
      "CLIPS_VISUAL_ANALYSIS_ENABLED=true",
      "CLIPS_VISUAL_ANALYSIS_PROVIDER=gemini",
      "GEMINI_API_KEY=local-mock-no-network",
    );
  }

  const command = `node -e ${shellQuote(createLoopbackRelay(containers.kongName, local.apiOrigin))} & exec ./node_modules/.bin/next dev --hostname 127.0.0.1 --port 3104`;
  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    runnerName,
    "--network",
    containers.network,
  ];
  for (const value of environment) args.push("--env", value);
  args.push("--entrypoint", "sh", imageName, "-lc", command);
  await run("docker", args);
  await waitForRunner();
}

async function stopRunner() {
  await run("docker", ["rm", "-f", runnerName], { allowFailure: true });
}

function localSmokeEnvironment(local, needsApp = true) {
  const values = [
    "CLIPSFLOW_LOCAL_SUPABASE_URL=http://127.0.0.1:54321",
    `CLIPSFLOW_LOCAL_SUPABASE_ANON_KEY=${local.anonKey}`,
    `CLIPSFLOW_LOCAL_SUPABASE_SERVICE_ROLE_KEY=${local.serviceRoleKey}`,
  ];
  if (needsApp)
    values.unshift("CLIPSFLOW_LOCAL_SHORTS_BASE_URL=http://127.0.0.1:3104");
  return values;
}

async function runSmoke(local, script, needsApp = true) {
  const args = ["exec"];
  for (const value of localSmokeEnvironment(local, needsApp)) {
    args.push("--env", value);
  }
  args.push(runnerName, "./node_modules/.bin/tsx", script);
  try {
    await run("docker", args);
  } catch (error) {
    const { output: logs } = await run(
      "docker",
      ["logs", runnerName, "--tail", "250"],
      { allowFailure: true },
    );
    const diagnostics = logs
      .split(/\r?\n/u)
      .filter((line) => line.includes('"source":"api-shorts-projects"'))
      .slice(-8);
    if (diagnostics.length > 0) {
      console.error(`Local Shorts API diagnostics:\n${diagnostics.join("\n")}`);
    }
    throw error;
  }
}

async function runDatabaseAssertions(databaseName, testFile) {
  const sql = await readFile(resolve(workspace, testFile));
  await run(
    "docker",
    [
      "exec",
      "-i",
      databaseName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql },
  );
}

async function main() {
  let imageBuilt = false;
  try {
    const status = await run("pnpm", ["supabase", "status", "-o", "env"], {
      secretOutput: true,
    });
    const local = parseLocalSupabaseStatus(status.output);
    const containers = await discoverSupabaseContainers();

    await run("docker", [
      "build",
      "-f",
      "Dockerfile.worker",
      "-t",
      imageName,
      ".",
    ]);
    imageBuilt = true;

    await startRunner(local, containers, false);
    await runSmoke(local, "scripts/shorts-local-authenticated-upload-smoke.ts");
    await stopRunner();

    await startRunner(local, containers, true, false);
    await runSmoke(local, "scripts/shorts-local-authenticated-upload-smoke.ts");
    await stopRunner();

    await startRunner(local, containers, true);
    await runSmoke(local, "scripts/shorts-local-analysis-smoke.ts");
    await runSmoke(local, "scripts/youtube-local-publication-smoke.ts");
    await runSmoke(local, "scripts/shorts-tus-resume-local-smoke.ts", false);
    await runSmoke(local, "scripts/shorts-local-media-smoke.ts", false);
    await runSmoke(local, "scripts/shorts-local-motion-smoke.ts", false);
    await runDatabaseAssertions(
      containers.databaseName,
      "supabase/tests/shorts_studio.sql",
    );
    await runDatabaseAssertions(
      containers.databaseName,
      "supabase/tests/shorts_source_duration.sql",
    );

    console.log(
      "Local Docker Shorts E2E passed: authenticated Studio, closed-budget and worker-not-ready fail-closed gates, TUS upload/resume, audio and audio-video analysis, creator selection, renders/downloads, motion, YouTube mock, and 27 SQL assertions.",
    );
  } finally {
    await stopRunner();
    if (imageBuilt) {
      await run("docker", ["image", "rm", imageName], {
        allowFailure: true,
      });
    }
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Unknown local E2E error";
  console.error(`Local Docker Shorts E2E failed: ${message}`);
  process.exitCode = 1;
});
