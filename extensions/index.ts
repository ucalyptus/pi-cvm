/**
 * pi-cvm — Apple Container VM tools for pi
 *
 * Exposes the microVM-speed container lifecycle as native pi tools:
 *   - run / pool_start / exec / kill / cp / list   (sandbox lifecycle)
 *   - dlscan                                        (one-call torrent → ClamAV scan → quarantine)
 *
 * All execution happens inside Apple container Linux VMs on this machine —
 * full filesystem/network isolation from the host.
 *
 * Dev: `pi install ./pi-cvm` (or `bash install.sh`), then `/reload`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import os from "node:os";

const DEFAULT_IMAGE = "ubuntu:24.04";
const CONTAINER = "container";
const pExecFile = promisify(execFile);

// Async on purpose: execFileSync ignores AbortSignal at runtime, so an aborted
// signal would NOT cancel a long `container run`. Async execFile honors it.
async function run(cliArgs: string[], opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<string> {
	try {
		const { stdout } = await pExecFile(CONTAINER, cliArgs, {
			encoding: "utf8",
			timeout: opts.timeout ?? 120_000,
			signal: opts.signal,
			maxBuffer: 32 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (e: any) {
		if (opts.signal?.aborted) throw new Error("cvm: cancelled");
		const detail = (e.stderr || e.stdout || String(e)).trim().split("\n").slice(-6).join("\n");
		const code = typeof e.code === "number" ? ` (exit ${e.code})` : "";
		throw new Error(`container ${cliArgs.join(" ")} failed${code}:\n${detail}`);
	}
}

async function isRunning(name: string): Promise<boolean> {
	try {
		const out = await run(["list"], { timeout: 10_000 });
		return out.split("\n").slice(1).some((l) => l.trim().split(/\s+/)[0] === name);
	} catch {
		return false;
	}
}

async function waitGone(name: string, timeoutMs = 300_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (await isRunning(name)) {
		if (Date.now() > deadline) throw new Error(`cvm: '${name}' still running after ${timeoutMs / 1000}s`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

async function listContainers(): Promise<string> {
	const out = await run(["list"], { timeout: 10_000 });
	return out || "(no containers)";
}

export type CvmDetails = { path?: string; md5?: string; seconds?: string };

const cvmParameters = Type.Object({
	action: StringEnum([
		"run",
		"pool_start",
		"exec",
		"kill",
		"cp",
		"list",
		"scan",
		"dlscan",
	] as const),
	name: Type.String({ description: "container name (e.g. agent-<task> or pool-1)" }),
	command: Type.Optional(Type.Array(Type.String(), { description: "argv to run inside the VM, e.g. [\"sh\",\"-c\",\"apt-get install -y ripgrep\"]" })),
	image: Type.Optional(Type.String({ description: `base image (default ${DEFAULT_IMAGE})` })),
	cpus: Type.Optional(Type.Number({ description: "vCPUs (default 2)" })),
	memory: Type.Optional(Type.String({ description: "memory e.g. \"4g\" (default 4g)" })),
	network_none: Type.Optional(Type.Boolean({ description: "air-gap: --network none --no-dns" })),
	detached: Type.Optional(Type.Boolean({ description: "run: return after boot, poll until auto-deleted (no output capture)" })),
	source_path: Type.Optional(Type.String({ description: "cp: 'NAME:/path/in/vm'" })),
	dest_path: Type.Optional(Type.String({ description: "cp: host destination path" })),
	scan_path: Type.Optional(Type.String({ description: "scan: absolute path inside the VM (file or dir)" })),
	magnet: Type.Optional(Type.String({ description: "dlscan: magnet: URI to download" })),
	dest_dir: Type.Optional(Type.String({ description: "dlscan: host destination dir (default ~/Downloads/Movies)" })),
	keep_vm: Type.Optional(Type.Boolean({ description: "dlscan: keep the VM running after the pipeline (default tears down)" })),
});

export default function cvmExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof cvmParameters, CvmDetails>({
		name: "cvm",
		label: "Apple Container VM Sandbox",
		description:
			"Execute arbitrary commands and one-off jobs inside disposable Apple container Linux VMs on this Mac — " +
			"full filesystem/network isolation from the host at microVM speed (one-shot cycle ~0.72s, warm-pool exec ~0.04s, " +
			"teardown ~0.18s). Use for ANY task needing an isolated Linux sandbox: running untrusted code or scripts, package " +
			"installs, scraping, builds, media processing, malware triage, or risky downloads — then copy results out and auto-teardown. " +
			"Includes: run (one-shot), pool_start/exec (warm pool), scan (ClamAV in-VM), dlscan (download -> scan -> quarantine pipeline), " +
			"cp, kill, list.",
		promptSnippet: "Run commands/one-off jobs inside disposable isolated Apple container Linux VMs on this Mac (cvm: run/pool/exec/scan/dlscan/cp/kill/list)",
		promptGuidelines: [
			"Use cvm for any task that needs an isolated Linux sandbox (untrusted code, risky downloads, scraping, builds) — it runs in a disposable VM that is deleted afterwards; nothing touches the host.",
			"Use cvm dlscan for torrent/magnet downloads: it downloads inside the VM, ClamAV-scans, copies out with a quarantine flag, and tears down.",
			"When cvm run needs no output captured (long jobs), set detached=true and poll via action=list.",
		],
		parameters: cvmParameters,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) {
				return { content: [{ type: "text" as const, text: "cvm: cancelled" }], details: {} };
			}
			const action = params.action as string;
			const name = params.name as string;
			const cmd = (params.command as string[] | undefined) ?? [];
			const img = (params.image as string | undefined) ?? DEFAULT_IMAGE;
			const cpus = params.cpus as number | undefined;
			const mem = (params.memory as string | undefined) ?? "4g";
			const net = params.network_none ? ["--network", "none", "--no-dns"] : [];

			switch (action) {
				case "run": {
					const args = ["run", "--rm", "--name", name, ...(cpus ? ["--cpus", String(cpus)] : []), "--memory", mem, ...net, img, ...(cmd.length ? cmd : ["sh", "-c", "echo cvm-ok"])];
					if (params.detached) {
						await run(["run", "-d", ...args.slice(1)], { signal });
						await waitGone(name);
						return { content: [{ type: "text" as const, text: `cvm: '${name}' ran and was auto-deleted.` }], details: {} };
					}
					const out = await run(args, { signal, timeout: 3_600_000 });
					return { content: [{ type: "text" as const, text: out || `cvm: '${name}' finished (no output).` }], details: {} };
				}
				case "pool_start": {
					const args = ["run", "-d", "--name", name, ...(cpus ? ["--cpus", String(cpus)] : []), "--memory", mem, ...net, img, "sleep", "86400"];
					await run(args, { signal });
					return { content: [{ type: "text" as const, text: `cvm: pool '${name}' ready — warm exec ~0.04s. Use action=exec.` }], details: {} };
				}
				case "exec": {
					if (!(await isRunning(name))) throw new Error(`cvm: '${name}' not running — start a pool first (action=pool_start).`);
					const args = ["exec", name, ...(cmd.length ? cmd : ["sh", "-c", "echo ok"])];
					const out = await run(args, { signal });
					return { content: [{ type: "text" as const, text: out || "(no output)" }], details: {} };
				}
				case "kill": {
					try { await run(["kill", name], { signal }); } catch { /* already stopped */ }
					try { await run(["rm", "-f", name], { signal }); } catch { /* already gone */ }
					return { content: [{ type: "text" as const, text: `cvm: '${name}' torn down (0.18s).` }], details: {} };
				}
				case "cp": {
					const src = params.source_path as string;
					const dst = params.dest_path as string;
					if (!src || !dst) throw new Error("cvm cp: source_path ('NAME:/path') and dest_path required");
					await run(["cp", src, dst], { signal });
					return { content: [{ type: "text" as const, text: `cvm: copied ${src} -> ${dst}` }], details: {} };
				}
				case "list":
					return { content: [{ type: "text" as const, text: await listContainers() }], details: {} };

				case "scan": {
					const scanPath = params.scan_path as string | undefined;
					if (!scanPath) throw new Error("cvm scan: 'scan_path' (absolute path inside the VM) required");
					if (!(await isRunning(name))) throw new Error(`cvm: '${name}' not running — start one first (pool_start or run -d)`);
					const out = await run([
						"exec", name, "bash", "-c",
						`command -v clamscan >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq clamav >/dev/null 2>&1 && freshclam >/dev/null 2>&1 || true); ` +
						`clamscan --max-filesize=10G --max-scansize=10G -r "${scanPath}" 2>&1 | tail -8`,
					], { signal, timeout: 1_800_000 });
					return { content: [{ type: "text" as const, text: out || "(scan produced no output)" }], details: {} };
				}

				case "dlscan": {
					const magnet = params.magnet as string | undefined;
					if (!magnet || !magnet.startsWith("magnet:")) throw new Error("cvm dlscan: a valid 'magnet' param is required");
					const destRaw = (params.dest_dir as string | undefined) ?? "~/Downloads/Movies";
					const dest = destRaw.replace(/^~\//, `${os.homedir()}/`);
					mkdirSync(dest, { recursive: true });
					const t0 = Date.now();

					// Boot a detached VM that stays up for the whole pipeline
					await run(["run", "-d", "--name", name, ...(cpus ? ["--cpus", String(cpus)] : []), "--memory", mem, img, "sleep", "86400"], { signal });
					try {
						const pipeline = [
							"set -e",
							"export DEBIAN_FRONTEND=noninteractive",
							"apt-get update -qq >/dev/null 2>&1",
							"apt-get install -y -qq transmission-cli clamav >/dev/null 2>&1",
							"mkdir -p /dl",
							`freshclam > /dl/fc.log 2>&1 & FCPID=$!`,
							`nohup transmission-cli --download-dir=/dl '${magnet}' > /dl/t.log 2>&1 & TPID=$!`,
							`DONE=0`,
							`for i in $(seq 1 600); do`,
							`  P=$(tr '\\r' '\\n' < /dl/t.log 2>/dev/null | grep 'Progress: 100.0%' | head -1)`,
							`  if [ -n "$P" ] && ! kill -0 $FCPID 2>/dev/null; then DONE=1; break; fi`,
							`  sleep 5`,
							`done`,
							`[ "$DONE" = 1 ] || { echo 'TIMEOUT: no 100% within 50 min'; exit 2; }`,
							`kill $TPID 2>/dev/null || true`,
							`MKV=$(ls /dl/*.mkv 2>/dev/null | head -1)`,
							`[ -n "$MKV" ] || { echo 'NO_MKV'; ls -la /dl; exit 3; }`,
							`echo DLPATH=$MKV`,
							`clamscan --max-filesize=10G --max-scansize=10G "$MKV" 2>&1 | tail -4`,
						].join("\n");
						const out = await run(["exec", name, "bash", "-c", pipeline], { signal, timeout: 3_600_000 });

						const m = out.match(/DLPATH=(\S+)/);
						if (!m) throw new Error(`dlscan: pipeline failed\n${out}`);
						const dlpath = m[1];
						const basename = dlpath.split("/").pop()!;
						const hostPath = `${dest}/${basename}`;

						await run(["cp", `${name}:${dlpath}`, hostPath], { signal });
						const uuid = execSync("uuidgen").toString().trim();
						execSync(`xattr -w com.apple.quarantine "0083;${uuid};pi-cvm;" "${hostPath}"`);
						const md5 = execSync(`md5 -q "${hostPath}"`).toString().trim();
						const secs = ((Date.now() - t0) / 1000).toFixed(1);
						return {
							content: [{
								type: "text" as const,
								text: `dlscan complete in ${secs}s\nin-VM: ${dlpath}\nhost: ${hostPath}\nmd5: ${md5}\nquarantine: set\nscan:\n${out}`,
							}],
							details: { path: hostPath, md5, seconds: secs },
						};
					} finally {
						if (!params.keep_vm) {
							try { await run(["kill", name], { signal }); } catch { /* gone */ }
							try { await run(["rm", "-f", name], { signal }); } catch { /* gone */ }
						}
					}
				}

				default:
					throw new Error(`cvm: unknown action '${action}'`);
			}
		},
	});

	pi.registerCommand("cvm", {
		description: "Run an Apple container VM one-shot task (cvm run <name> -- <cmd...>)",
		handler: async (args, ctx) => {
			const text = args?.trim();
			if (!text) {
				ctx.ui.notify("usage: /cvm run <name> -- <cmd...>", "info");
				return;
			}
			const [name, ...rest] = text.split(/\s+/);
			const sep = rest.indexOf("--");
			const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
			try {
				const out = await run(["run", "--rm", "--name", name, DEFAULT_IMAGE, ...(cmd.length ? cmd : ["sh", "-c", "echo cvm-ok"])], { timeout: 3_600_000 });
				ctx.ui.notify(`cvm: ${out || "done"}`, "info");
			} catch (e: any) {
				ctx.ui.notify(`cvm error: ${e.message}`, "error");
			}
		},
	});
}
