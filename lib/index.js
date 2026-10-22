/**
 * dsh-plugin-guard — host 半。
 *
 * 把 ~/.dsh/plugin-guard 的守护状态通过 web GUI 的同源 HTTP 路由暴露出去：
 *   GET  /api/plugin-guard/state                 守护状态 + 仓库矩阵 + 报告/快照清单 + 当前配置
 *   POST /api/plugin-guard/run                   触发一次 guard.ps1（manual / daily / login）
 *   POST /api/plugin-guard/stop                  停止正在运行的扫描
 *   GET  /api/plugin-guard/report?name=<file>    读取某份报告原文
 *
 * webServer 服务本身不带认证，所有写操作自己校验同源（同 dsh-agency-agents 的做法）。
 * 配置项见 Config（全部可从 profile 的 cordis.patch.yml 覆盖）。
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const BUNDLED_BACKEND = fileURLToPath(new URL("../backend/", import.meta.url));

export const name = "plugin-guard";
export const inject = ["webServer"];

/** schemastery 由 DSH 运行时提供；解析不到时退化为「无 schema、任意 config」，插件仍可用。 */
let Schema = null;
try {
  const mod = await import("@deepseek-ai/schemastery");
  Schema = mod && mod.default ? mod.default : null;
} catch {
  Schema = null;
}

export const Config = Schema
  ? Schema.object({
      /** 守护目录；留空 = $DSH_HOME/plugin-guard */
      guardDir: Schema.string().default(""),
      /** 面板「立即扫描」用的模式：manual | daily | login */
      defaultMode: Schema.string().default("manual"),
      /** 单个 URL 的 curl 超时秒数（透传 guard.ps1 -ProbeTimeout） */
      probeTimeoutSec: Schema.number().default(8),
      /** 单次扫描的硬超时（毫秒），到点整树 kill */
      runTimeoutMs: Schema.number().default(1200000),
      /** 面板列出的报告条数上限 */
      reportLimit: Schema.number().default(20),
      /** 运行输出保留的最大字符数 */
      tailLimit: Schema.number().default(8000),
      /** 仓库明细最多返回多少行 */
      repoLimit: Schema.number().default(200),
      /** 是否允许面板触发扫描/停止（false = 只读面板） */
      allowActions: Schema.boolean().default(false),
      enableSnapshots: Schema.boolean().default(false),
      /** 空闲时面板轮询间隔（毫秒） */
      pollIntervalMs: Schema.number().default(15000),
      /** 扫描进行中的轮询间隔（毫秒） */
      runningPollIntervalMs: Schema.number().default(2500),
      /** 传给 guard.ps1 的 -Profiles：all | desktop | web */
      guardProfiles: Schema.string().default("all"),
      /** 上游消失后的接管档位：off | report | stage | review | auto */
      takeoverMode: Schema.string().default("review"),
      /** 连续多少次扫描都不可达才认定上游死亡（默认 3） */
      takeoverConfirmRuns: Schema.number().default(3),
      /** 连续不可达持续多少小时才认定上游死亡（默认 24） */
      takeoverMinHours: Schema.number().default(24),
      /** 是否要求 npm registry 也查不到该包（默认 true：报告从宽、接管从严） */
      takeoverRequireNpmGone: Schema.boolean().default(true),
      /** 单次扫描最多接管几个包，0 = 不限制（auto 档生效） */
      takeoverMaxPerRun: Schema.number().default(1),
      /** 滚动 24 小时内最多接管几个包，0 = 不限制（防止一天内把 vendor 清空） */
      takeoverMaxTotal: Schema.number().default(5),
      /** 连续失败多少次自动熔断，停止接管直到人工复位（默认 3） */
      takeoverFailureBreaker: Schema.number().default(3),
      /** 每个包保留几个 vendor 版本 */
      takeoverKeepVersions: Schema.number().default(3),
      /** 允许接管哪些 profile：all | desktop | web | desktop,web */
      takeoverAllowProfiles: Schema.string().default("all"),
      /** 接管后是否推送通知 */
      takeoverNotify: Schema.boolean().default(false),
      /** 追加给 guard.ps1 的额外参数，空格分隔（如 "-NoSnapshot"） */
      extraArgs: Schema.string().default(""),
    })
  : undefined;

const HOME_DIR = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const DEFAULT_GUARD_DIR = path.join(HOME_DIR, "plugin-guard");
const MODES = new Set(["manual", "daily", "login"]);
const PROFILE_SCOPES = new Set(["all", "desktop", "web"]);
const TAKEOVER_MODES = new Set(["off", "report", "stage", "review", "auto"]);

const DEFAULTS = {
  guardDir: "",
  defaultMode: "manual",
  probeTimeoutSec: 8,
  runTimeoutMs: 20 * 60 * 1000,
  reportLimit: 20,
  tailLimit: 8000,
  repoLimit: 200,
  allowActions: false,
  enableSnapshots: false,
  pollIntervalMs: 15000,
  runningPollIntervalMs: 2500,
  guardProfiles: "all",
  takeoverMode: "review",
  takeoverConfirmRuns: 3,
  takeoverMinHours: 24,
  takeoverRequireNpmGone: true,
  takeoverMaxPerRun: 1,
  takeoverMaxTotal: 5,
  takeoverFailureBreaker: 3,
  takeoverKeepVersions: 3,
  takeoverAllowProfiles: "all",
  takeoverNotify: false,
  extraArgs: "",
};

/** 当前生效配置（apply 时由 cordis 传入的 config 覆盖）。 */
const settings = { ...DEFAULTS };

function clampInt(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** 档位归一化：显式合法值优先；老配置里遗留的 -NoTakeover 映射为 off。 */
function normalizeTakeoverMode(input) {
  const raw = typeof input.takeoverMode === "string" ? input.takeoverMode.trim().toLowerCase() : "";
  if (TAKEOVER_MODES.has(raw)) return raw;
  const legacyOff = typeof input.extraArgs === "string" && /(^|\s)-NoTakeover(\s|$)/.test(input.extraArgs);
  return legacyOff ? "off" : DEFAULTS.takeoverMode;
}

/** 允许接管的 profile：all，或 desktop / web 的逗号组合。 */
function normalizeTakeoverProfiles(raw) {
  if (typeof raw !== "string") return DEFAULTS.takeoverAllowProfiles;
  const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0 || parts.includes("all")) return "all";
  const allowed = [...new Set(parts.filter((p) => p === "desktop" || p === "web"))];
  return allowed.length > 0 ? allowed.join(",") : "all";
}

/** 把用户配置归一化：非法值回退默认，避免一处笔误让插件整体不可用。 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const dir = typeof input.guardDir === "string" && input.guardDir.trim() !== "" ? path.resolve(input.guardDir.trim()) : DEFAULT_GUARD_DIR;
  const mode = typeof input.defaultMode === "string" && MODES.has(input.defaultMode) ? input.defaultMode : DEFAULTS.defaultMode;
  const profiles = typeof input.guardProfiles === "string" && PROFILE_SCOPES.has(input.guardProfiles) ? input.guardProfiles : DEFAULTS.guardProfiles;
  return {
    guardDir: dir,
    defaultMode: mode,
    probeTimeoutSec: clampInt(input.probeTimeoutSec, DEFAULTS.probeTimeoutSec, 1, 60),
    runTimeoutMs: clampInt(input.runTimeoutMs, DEFAULTS.runTimeoutMs, 10000, 6 * 60 * 60 * 1000),
    reportLimit: clampInt(input.reportLimit, DEFAULTS.reportLimit, 1, 500),
    tailLimit: clampInt(input.tailLimit, DEFAULTS.tailLimit, 500, 200000),
    repoLimit: clampInt(input.repoLimit, DEFAULTS.repoLimit, 1, 5000),
    allowActions: input.allowActions === true,
    enableSnapshots: input.enableSnapshots === true,
    pollIntervalMs: clampInt(input.pollIntervalMs, DEFAULTS.pollIntervalMs, 1000, 600000),
    runningPollIntervalMs: clampInt(input.runningPollIntervalMs, DEFAULTS.runningPollIntervalMs, 500, 60000),
    guardProfiles: profiles,
    takeoverMode: normalizeTakeoverMode(input),
    takeoverConfirmRuns: clampInt(input.takeoverConfirmRuns, DEFAULTS.takeoverConfirmRuns, 1, 50),
    takeoverMinHours: clampInt(input.takeoverMinHours, DEFAULTS.takeoverMinHours, 0, 8760),
    takeoverRequireNpmGone: input.takeoverRequireNpmGone !== false,
    takeoverMaxPerRun: clampInt(input.takeoverMaxPerRun, DEFAULTS.takeoverMaxPerRun, 0, 20),
    takeoverMaxTotal: clampInt(input.takeoverMaxTotal, DEFAULTS.takeoverMaxTotal, 0, 200),
    takeoverFailureBreaker: clampInt(input.takeoverFailureBreaker, DEFAULTS.takeoverFailureBreaker, 1, 50),
    takeoverKeepVersions: clampInt(input.takeoverKeepVersions, DEFAULTS.takeoverKeepVersions, 1, 20),
    takeoverAllowProfiles: normalizeTakeoverProfiles(input.takeoverAllowProfiles),
    takeoverNotify: input.takeoverNotify === true,
    extraArgs: typeof input.extraArgs === "string" ? input.extraArgs.split(/\s+/).filter(x => ["-DryRun", "-NoSnapshot", "-Snapshot"].includes(x)).join(" ") : "",
  };
}

/** 由当前配置派生的路径集合。 */
function paths() {
  const dir = settings.guardDir || DEFAULT_GUARD_DIR;
  return {
    dir,
    stateFile: path.join(dir, "state.json"),
    reportsDir: path.join(dir, "reports"),
    snapshotsDir: path.join(dir, "snapshots"),
    guardScript: path.join(BUNDLED_BACKEND, "guard.ps1"),
  };
}

/** 当前/最近一次手动运行的快照，供 UI 显示进度与结果。 */
const runtime = {
  running: false,
  stopping: false,
  startedAt: null,
  mode: null,
  probeTimeoutSec: null,
  exitCode: null,
  finishedAt: null,
  durationMs: null,
  tail: "",
  error: null,
};

/** 当前子进程与硬超时：guard 要逐源探测，最坏会跑十几分钟。 */
let activeChild = null;
let runTimer = null;
let stopTimer = null;
let finalizeChild = null;
const STOP_GRACE_MS = 5000;

/** Windows 下 kill 只杀直接子进程，管道被孙进程继承会让 close 永不触发，必须整树杀。 */
function killTree(child) {
  if (!child || typeof child.pid !== "number") return;
  const fallback = () => {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch {} }
  };
  try {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", fallback);
    killer.once("exit", code => { if (code !== 0) fallback(); });
  } catch { fallback(); }
}

function isLoopbackAddress(address) {
  if (typeof address !== "string" || address === "") return false;
  return address === "::1" || address === "[::1]" || address === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(address) || address === "::ffff:127.0.0.1";
}

function header(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** 只有本机同源页面（带我们自己的头）才允许进入。 */
function isTrustedRequest(request) {
  if (header(request, "x-plugin-guard") !== "1") return false;
  if (request.socket?.remoteAddress === "localhost" || !isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const site = header(request, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  const host = header(request, "host");
  if (host === undefined || host === "") return false;
  const origin = header(request, "origin");
  if (origin === undefined || origin === "") {
    try {
      return isLoopbackAddress(new URL("http://" + host).hostname);
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackAddress(url.hostname) && url.host === host;
  } catch {
    return false;
  }
}

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listReports() {
  const { reportsDir } = paths();
  let names = [];
  try {
    names = await fs.readdir(reportsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.startsWith("guard-") || !name.endsWith(".json")) continue;
    try {
      const stat = await fs.stat(path.join(reportsDir, name));
      out.push({ name, mtime: stat.mtime.toISOString(), at: name.replace(/^guard-/, "").replace(/\.json$/, ""), size: stat.size });
    } catch {
      /* 读不到就跳过 */
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out.slice(0, settings.reportLimit);
}

async function countFiles(dir) {
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let children;
    try {
      children = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isDirectory()) stack.push(path.join(current, child.name));
      else files += 1;
    }
  }
  return files;
}

async function listSnapshots() {
  const { snapshotsDir } = paths();
  const out = [];
  const visit = async (dir, depth) => {
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const manifest = entries.find(e => e.isFile() && e.name === ".guard-manifest.json");
    if (manifest) {
      const meta = await readJson(path.join(dir, manifest.name));
      const files = Math.max(0, await countFiles(dir) - 1);
      out.push({name: path.relative(snapshotsDir, dir).split(path.sep).join("/"), files, empty: files === 0,
        layout: "content-addressed", verified: false, verification: meta ? "manifest-present-not-rechecked" : "invalid-manifest", profile: meta?.profile ?? null});
      return;
    }
    const isLegacyVersion = depth === 2 && (entries.length === 0 || entries.some(e => e.isFile()));
    if (isLegacyVersion) {
      const files = await countFiles(dir);
      out.push({name: path.relative(snapshotsDir, dir).split(path.sep).join("/"), files, empty: files === 0, layout: "legacy", verified: false, verification: "legacy-unverified"});
      return;
    }
    if (depth >= 3) {
      out.push({name:path.relative(snapshotsDir,dir).split(path.sep).join("/"),files:await countFiles(dir),empty:false,layout:"incomplete",verified:false,verification:"missing-manifest"});return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".staging-")) await visit(path.join(dir, e.name), depth+1);
  };
  await visit(snapshotsDir,0);
  return out.sort((a,b)=>a.name.localeCompare(b.name));
}

function normalizeRepos(state) {
  const raw = state?.repos;
  if (!raw || typeof raw !== "object") return [];
  const rows = [];
  for (const [repo, value] of Object.entries(raw)) {
    if (rows.length >= settings.repoLimit) break;
    const item = value && typeof value === "object" ? value : {};
    rows.push({
      repo,
      status: typeof item.status === "string" ? item.status : "unknown",
      web: item.web ?? null,
      codeload: item.codeload ?? null,
      npm: item.npm ?? null,
      packages: Array.isArray(item.packages) ? item.packages : [],
      profiles: Array.isArray(item.profiles) ? item.profiles : [],
      lastProbe: item.lastProbe ?? null,
      firstSeen: item.firstSeen ?? null,
      deadSince: item.deadSince ?? null,
      confirmedAt: item.confirmedAt ?? null,
      consecutiveDead: typeof item.consecutiveDead === "number" ? item.consecutiveDead : 0,
      upstreamStatus: item.upstreamStatus ?? "unknown",
      upstreamReviewAt: item.upstreamReviewAt ?? null,
      legacyTakeover: item.legacyTakeover ?? item.takeover ?? null,
      lastTakeover: item.lastTakeover ?? null,
    });
  }
  const rank = { dead: 0, pending: 1, unknown: 2, alive: 3 };
  rows.sort((a, b) => {
    const d = (rank[a.status] ?? 2) - (rank[b.status] ?? 2);
    return d !== 0 ? d : a.repo.localeCompare(b.repo);
  });
  return rows;
}

function buildSummary(repos, reports, snapshots) {
  const packages = new Set();
  for (const repo of repos) for (const pkg of repo.packages) packages.add(pkg);
  const count = (status) => repos.filter((r) => r.status === status).length;
  return {
    repos: repos.length,
    alive: count("alive"),
    dead: count("dead"),
    pending: count("pending") + count("unknown"),
    confirmed: repos.filter((r) => r.status === "dead" && Boolean(r.confirmedAt)).length,
    upstreamMissing: repos.filter(r => r.upstreamStatus === "missing").length,
    legacyTakeovers: repos.filter(r => r.legacyTakeover?.ok === true).length,
    pendingTakeovers: repos.filter(r => r.lastTakeover?.pendingConfirm === true).length,
    takenOver: repos.filter(r => r.lastTakeover?.ok === true && String(r.lastTakeover?.step) === "apply").length,
    packages: packages.size,
    profiles: new Set(repos.flatMap((r) => r.profiles)).size,
    reports: reports.length,
    snapshots: snapshots.length,
    emptySnapshots: snapshots.filter((s) => s.empty).length,
  };
}

/** 对外暴露的配置视图（不含路径以外的敏感信息，前端用来对齐轮询节奏）。 */
function publicConfig() {
  return {
    defaultMode: settings.defaultMode,
    probeTimeoutSec: settings.probeTimeoutSec,
    runTimeoutMs: settings.runTimeoutMs,
    reportLimit: settings.reportLimit,
    repoLimit: settings.repoLimit,
    allowActions: settings.allowActions,
    enableSnapshots: settings.enableSnapshots,
    pollIntervalMs: settings.pollIntervalMs,
    runningPollIntervalMs: settings.runningPollIntervalMs,
    guardProfiles: settings.guardProfiles,
    takeover: {
      mode: settings.takeoverMode,
      confirmRuns: settings.takeoverConfirmRuns,
      minHours: settings.takeoverMinHours,
      requireNpmGone: settings.takeoverRequireNpmGone,
      maxPerRun: settings.takeoverMaxPerRun,
      maxTotal: settings.takeoverMaxTotal,
      failureBreaker: settings.takeoverFailureBreaker,
      keepVersions: settings.takeoverKeepVersions,
      allowProfiles: settings.takeoverAllowProfiles,
      notify: settings.takeoverNotify,
    },
    hasSchema: Schema !== null,
  };
}

async function buildState() {
  const { dir, stateFile } = paths();
  const state = await readJson(stateFile);
  const reports = await listReports();
  const snapshots = await listSnapshots();
  const repos = normalizeRepos(state);
  const hasRun = runtime.startedAt !== null;
  return {
    ok: state !== null,
    warning: state === null ? "尚无有效扫描状态；不是零异常证明。" : null,
    generatedAt: new Date().toISOString(),
    guardDir: dir,
    version: state?.version ?? null,
    takeoverLedger: state?.takeoverLedger ?? null,
    lastRun: state?.lastRun ?? null,
    lastMode: state?.lastMode ?? null,
    running: runtime.running,
    stopping: runtime.stopping,
    platform: process.platform,
    config: publicConfig(),
    lastRunResult: hasRun
      ? {
          mode: runtime.mode,
          probeTimeoutSec: runtime.probeTimeoutSec,
          startedAt: runtime.startedAt,
          finishedAt: runtime.finishedAt,
          exitCode: runtime.exitCode,
          durationMs: runtime.durationMs,
          error: runtime.error,
          tail: runtime.tail,
        }
      : null,
    summary: buildSummary(repos, reports, snapshots),
    repos,
    reports,
    snapshots,
  };
}

/** 按 run-guard.cmd 同样的优先级找一个 pwsh.exe。 */
function resolvePwsh() {
  const candidates = [
    process.env.DSH_GUARD_PWSH || "",
    ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map(p => path.join(p, "pwsh.exe")),
    path.join(process.env.ProgramFiles || "C:" + path.sep + "Program Files", "PowerShell", "7", "pwsh.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "pwsh.exe"),
    path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@dsh-ops", "pwsh-win32-x64", "bin", "pwsh.exe"),
    path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "@dsh-ops", "pwsh-win32-x64", "bin", "pwsh.exe"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function startGuard(mode, probeTimeoutSec) {
  if (runtime.running || runtime.stopping || activeChild) return { started: false, reason: "already-running" };
  if (process.platform !== "win32") return { started: false, reason: "unsupported-platform" };
  const pwsh = resolvePwsh();
  if (pwsh === null) return { started: false, reason: "no-pwsh" };
  const { dir, guardScript } = paths();
  if (!existsSync(guardScript)) return { started: false, reason: "no-guard-script" };

  const effectiveTimeout = probeTimeoutSec ?? settings.probeTimeoutSec;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", guardScript, "-Mode", mode, "-Profiles", settings.guardProfiles,
    "-DshHome", HOME_DIR, "-GuardDir", dir, "-ProbeTimeout", String(effectiveTimeout),
    "-TakeoverMode", settings.takeoverMode,
    "-TakeoverAllowProfiles", settings.takeoverAllowProfiles,
    "-TakeoverMaxPerRun", String(settings.takeoverMaxPerRun),
    "-TakeoverMaxTotal", String(settings.takeoverMaxTotal),
    "-TakeoverFailureBreaker", String(settings.takeoverFailureBreaker),
    "-KeepVersions", String(settings.takeoverKeepVersions),
    "-ConfirmRuns", String(settings.takeoverConfirmRuns),
    "-MinHours", String(settings.takeoverMinHours),
    "-RequireNpmGone", settings.takeoverRequireNpmGone ? "true" : "false"];
  const snapshotEnabled = (settings.enableSnapshots || settings.extraArgs.split(/\s+/).includes("-Snapshot")) && !settings.extraArgs.split(/\s+/).includes("-NoSnapshot");
  args.push(snapshotEnabled ? "-Snapshot" : "-NoSnapshot");
  if (settings.extraArgs.includes("-DryRun")) args.push("-DryRun");

  runtime.running = true;
  runtime.stopping = false;
  runtime.startedAt = new Date().toISOString();
  runtime.finishedAt = null;
  runtime.exitCode = null;
  runtime.durationMs = null;
  runtime.error = null;
  runtime.mode = mode;
  runtime.probeTimeoutSec = probeTimeoutSec !== null ? probeTimeoutSec : settings.probeTimeoutSec;
  runtime.tail = "";
  const startedAtMs = Date.now();

  let child;
  try {
    child = spawn(pwsh, args, {
      cwd: BUNDLED_BACKEND,
      env: { ...process.env, DSH_HOME: HOME_DIR, DSH_GUARD_DIR: dir },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    runtime.running = false;
    runtime.error = error instanceof Error ? error.message : String(error);
    runtime.finishedAt = new Date().toISOString();
    return { started: false, reason: "spawn-failed", error: runtime.error };
  }

  activeChild = child;
  const timeoutMs = settings.runTimeoutMs;
  runTimer = setTimeout(() => {
    if (activeChild !== child) return;
    runTimer = null;
    stopGuard("运行超过 " + Math.round(timeoutMs / 1000) + " 秒；已请求停止。");
  }, timeoutMs);

  const append = (chunk) => {
    runtime.tail = (runtime.tail + chunk.toString()).slice(-settings.tailLimit);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => {
    if (activeChild !== child) return;
    runtime.error = error instanceof Error ? error.message : String(error);
  });
  const finish = (code, pipeFallback = false) => {
    if (activeChild !== child) return;
    if (runTimer !== null) clearTimeout(runTimer);
    if (stopTimer !== null) clearTimeout(stopTimer);
    runTimer = null; stopTimer = null; activeChild = null; finalizeChild = null;
    runtime.running = false; runtime.stopping = false;
    runtime.exitCode = typeof code === "number" ? code : null;
    runtime.finishedAt = new Date().toISOString();
    runtime.durationMs = Date.now() - startedAtMs;
    if (pipeFallback) runtime.error = "主进程已退出，输出管道超时后已关闭；未声称所有后代均已退出。";
  };
  finalizeChild = finish;
  child.on("close", code => finish(code));
  return { started: true, pid: child.pid ?? null, probeTimeoutSec: runtime.probeTimeoutSec, args };
}

function requestUrl(request) {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

async function handleState(request, response) {
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET" });
    response.end();
    return;
  }
  json(response, 200, await buildState());
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleRun(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }
  if (!isTrustedRequest(request)) {
    json(response, 403, { ok: false, error: "已拒绝非本机同源请求。" });
    return;
  }
  if (!settings.allowActions) {
    json(response, 403, { ok: false, error: "已在插件配置中禁用面板操作（allowActions: false）。", reason: "actions-disabled" });
    return;
  }
  let mode = settings.defaultMode;
  let probeTimeoutSec = null;
  try {
    const body = await readBody(request);
    if (body !== "") {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.mode === "string" && MODES.has(parsed.mode)) mode = parsed.mode;
      if (parsed && parsed.probeTimeoutSec !== undefined) {
        const value = clampInt(parsed.probeTimeoutSec, settings.probeTimeoutSec, 1, 60);
        probeTimeoutSec = value;
      }
    }
  } catch {
    /* 非法 body 按配置默认值处理 */
  }
  const result = startGuard(mode, probeTimeoutSec);
  if (!result.started) {
    const message =
      result.reason === "already-running"
        ? "已有扫描在运行，请等待完成。"
        : result.reason === "unsupported-platform"
          ? "上游守护依赖 PowerShell 与 guard.ps1，目前只支持 Windows。"
          : result.reason === "no-pwsh"
            ? "找不到 pwsh.exe，守护脚本无法执行。"
            : result.reason === "no-guard-script"
              ? "找不到 guard.ps1，守护目录不完整。"
              : result.error || "启动失败。";
    json(response, result.reason === "already-running" ? 409 : 503, { ok: false, error: message, reason: result.reason });
    return;
  }
  json(response, 200, { ok: true, started: true, mode, pid: result.pid, probeTimeoutSec: result.probeTimeoutSec });
}

function stopGuard(reason = "停止请求已发送；等待子进程退出。") {
  const child = activeChild;
  if (!child) return { ok: false, error: "当前没有运行中的扫描。" };
  runtime.running = false;
  runtime.stopping = true;
  runtime.error = reason;
  if (runTimer !== null) clearTimeout(runTimer);
  if (stopTimer !== null) clearTimeout(stopTimer);
  runTimer = null;
  killTree(child);
  stopTimer = setTimeout(() => {
    if (activeChild !== child) return;
    stopTimer = null;
    if (child.exitCode !== null || child.signalCode !== null) {
      child.stdout?.destroy(); child.stderr?.destroy();
      finalizeChild?.(child.exitCode, true);
    } else {
      runtime.error = "停止未确认：主进程仍存活，新扫描保持禁用；可重试停止或检查该进程。";
    }
  }, STOP_GRACE_MS);
  return { ok: true, stopping: true };
}

async function handleStop(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }
  if (!isTrustedRequest(request)) {
    json(response, 403, { ok: false, error: "已拒绝非本机同源请求。" });
    return;
  }
  if (!settings.allowActions) {
    json(response, 403, { ok: false, error: "已在插件配置中禁用面板操作（allowActions: false）。", reason: "actions-disabled" });
    return;
  }
  const result = stopGuard();
  json(response, result.ok ? 200 : 409, result);
}

async function handleReport(request, response) {
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET" });
    response.end();
    return;
  }
  const url = requestUrl(request);
  const name = url?.searchParams.get("name") ?? "";
  if (!/^guard-[0-9A-Za-z._-]+\.json$/.test(name)) {
    json(response, 400, { ok: false, error: "报告名不合法。" });
    return;
  }
  const { reportsDir } = paths();
  const payload = await readJson(path.join(reportsDir, name));
  if (payload === null) {
    json(response, 404, { ok: false, error: "报告不存在或无法解析。" });
    return;
  }
  json(response, 200, { ok: true, name, report: payload });
}

/** 面板点「确认接管」时调用 takeover.ps1 -Apply；超时后只杀主进程并如实报告。 */
const TAKEOVER_TIMEOUT_MS = 10 * 60 * 1000;
const PACKAGE_NAME_RE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const TAKEOVER_PROFILES = new Set(["desktop", "web"]);

function runTakeover(pkg, profile, repo) {
  return new Promise((resolve) => {
    const pwsh = resolvePwsh();
    if (pwsh === null) {
      resolve({ ok: false, error: "找不到 pwsh.exe，无法执行接管脚本。" });
      return;
    }
    const { dir } = paths();
    const script = path.join(BUNDLED_BACKEND, "takeover.ps1");
    if (!existsSync(script)) {
      resolve({ ok: false, error: "找不到 takeover.ps1，守护目录不完整。" });
      return;
    }
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Package", pkg, "-Profile", profile, "-Reason", "panel-confirmed", "-Apply", "-JsonOnly",
      "-KeepVersions", String(settings.takeoverKeepVersions),
      "-DshHome", HOME_DIR, "-GuardDir", dir];
    if (repo !== "") args.splice(args.indexOf("-Reason"), 0, "-Repo", repo);
    let child;
    try {
      child = spawn(pwsh, args, {
        cwd: BUNDLED_BACKEND,
        env: { ...process.env, DSH_HOME: HOME_DIR, DSH_GUARD_DIR: dir },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出则忽略 */
      }
    }, TAKEOVER_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      out = (out + chunk.toString()).slice(-400000);
    });
    child.stderr?.on("data", (chunk) => {
      err = (err + chunk.toString()).slice(-40000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      let payload = null;
      if (start >= 0 && end > start) {
        try {
          payload = JSON.parse(text.slice(start, end + 1));
        } catch {
          payload = null;
        }
      }
      if (payload === null) {
        resolve({ ok: false, exitCode: code, error: (err || text).slice(-4000) || "takeover.ps1 没有返回可解析的 JSON。" });
        return;
      }
      resolve({ ok: payload.ok === true, exitCode: code, payload });
    });
  });
}

async function handleTakeover(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }
  if (!isTrustedRequest(request)) {
    json(response, 403, { ok: false, error: "已拒绝非本机同源请求。" });
    return;
  }
  if (!settings.allowActions) {
    json(response, 403, { ok: false, error: "已在插件配置中禁用面板操作（allowActions: false）。", reason: "actions-disabled" });
    return;
  }
  if (runtime.running || runtime.stopping || activeChild) {
    json(response, 409, { ok: false, error: "扫描进行中，等它结束再确认接管。", reason: "already-running" });
    return;
  }
  let body = {};
  try {
    const raw = await readBody(request);
    if (raw !== "") body = JSON.parse(raw);
  } catch {
    body = {};
  }
  const pkg = typeof body.package === "string" ? body.package.trim() : "";
  const profile = typeof body.profile === "string" ? body.profile.trim().toLowerCase() : "";
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!PACKAGE_NAME_RE.test(pkg)) {
    json(response, 400, { ok: false, error: "包名不合法。" });
    return;
  }
  if (!TAKEOVER_PROFILES.has(profile)) {
    json(response, 400, { ok: false, error: "profile 只能是 desktop 或 web。" });
    return;
  }
  if (repo !== "" && !REPO_NAME_RE.test(repo)) {
    json(response, 400, { ok: false, error: "仓库名不合法。" });
    return;
  }
  const allowed = settings.takeoverAllowProfiles;
  if (allowed !== "all" && !allowed.split(",").includes(profile)) {
    json(response, 403, { ok: false, error: "配置不允许接管 " + profile + " profile。", reason: "profile-not-allowed" });
    return;
  }
  const result = await runTakeover(pkg, profile, repo);
  if (!result.ok) {
    json(response, 502, {
      ok: false,
      error: result.error || "接管失败。",
      exitCode: result.exitCode ?? null,
      payload: result.payload ?? null,
    });
    return;
  }
  json(response, 200, { ok: true, package: pkg, profile, payload: result.payload });
}

export function apply(ctx, rawConfig) {
  Object.assign(settings, normalizeConfig(rawConfig));
  if (typeof ctx.webServer?.register !== "function") return;
  const disposers = [];
  const register = (routePath, handler) => {
    disposers.push(ctx.webServer.register({ kind: "exact", path: routePath, handler }));
  };
  register("/api/plugin-guard/state", handleState);
  register("/api/plugin-guard/run", handleRun);
  register("/api/plugin-guard/stop", handleStop);
  register("/api/plugin-guard/report", handleReport);
  register("/api/plugin-guard/takeover", handleTakeover);
  ctx.effect(
    () => () => {
      if (activeChild) stopGuard();
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 已释放过就忽略 */
        }
      }
    },
    "plugin-guard: routes",
  );
}
