/**
 * dsh-plugin-guard —— client 半（浏览器，手写 bundle）。
 * 在设置页注册「上游守护」分区：仓库健康矩阵 + 扫描触发 + 报告/快照清单。
 * 只能 require shell 的 seed 词（react / react/jsx-runtime / primitives）。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    const { jsx, Fragment } = react_jsx_runtime;
    const { useCallback, useEffect, useMemo, useState } = react;

    const NS = "plugin-guard";
    const API = "/api/plugin-guard";
    const STYLE_ID = "PGU_style";

    const css = [
      ".PGU_root{display:flex;flex-direction:column;gap:16px;width:100%;max-width:860px;color:var(--dsw-alias-label-primary)}",
      ".PGU_head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".PGU_title{margin:0;font-size:15px;font-weight:600}",
      ".PGU_sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}",
      ".PGU_actions{display:flex;align-items:center;gap:8px}",
      ".PGU_btn{font:inherit;font-size:13px;border-radius:8px;padding:6px 14px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
      ".PGU_btn:disabled{opacity:.55;cursor:default}",
      ".PGU_btn[data-kind=primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}",
      ".PGU_btn[data-kind=danger]{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}",
      ".PGU_btn:disabled{opacity:.45;cursor:not-allowed}",
      ".PGU_cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}",
      ".PGU_card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv1)}",
      ".PGU_cardLabel{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}",
      ".PGU_cardValue{font-size:22px;font-weight:650;line-height:1.2;margin-top:2px}",
      ".PGU_cardHint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
      ".PGU_tone-ok{color:var(--dsw-alias-state-success-primary)}",
      ".PGU_tone-bad{color:var(--dsw-alias-state-error-primary)}",
      ".PGU_tone-warn{color:var(--dsw-alias-state-business-primary)}",
      ".PGU_matrix{display:flex;flex-wrap:wrap;gap:4px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}",
      ".PGU_cell{width:18px;height:18px;border-radius:4px;cursor:default;transition:transform .12s ease}",
      ".PGU_cell:hover{transform:scale(1.18)}",
      ".PGU_cell[data-s=alive]{background:var(--dsw-alias-state-success-primary)}",
      ".PGU_cell[data-s=dead]{background:var(--dsw-alias-state-error-primary)}",
      ".PGU_cell[data-s=pending]{background:var(--dsw-alias-state-business-primary)}",
      ".PGU_cell[data-s=unknown]{background:var(--dsw-alias-border-l2)}",
      ".PGU_sectionTitle{font-size:13px;font-weight:600;margin:0 0 6px}",
      ".PGU_table{width:100%;border-collapse:collapse;font-size:12.5px}",
      ".PGU_table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}",
      ".PGU_table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}",
      ".PGU_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
      ".PGU_dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}",
      ".PGU_state{white-space:nowrap}",
      ".PGU_badge{display:inline-block;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);margin-right:4px}",
      ".PGU_pkg{display:block;color:var(--dsw-alias-label-tertiary);font-size:11.5px}",
      ".PGU_note{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}",
      ".PGU_cfg{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}",
      ".PGU_cfgItem{padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1)}",
      ".PGU_cfgItem[data-warn=true]{color:var(--dsw-alias-state-business-primary);border-color:currentColor}",
      ".PGU_err{border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12.5px}",
      ".PGU_pre{margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;max-height:220px;overflow:auto;white-space:pre-wrap}",
      ".PGU_chips{display:flex;flex-wrap:wrap;gap:6px}",
      ".PGU_chip{font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
      ".PGU_chip[data-empty=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      ".PGU_reportRow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px}",
      ".PGU_link{color:var(--dsw-alias-state-business-primary);cursor:pointer;background:none;border:0;font:inherit;padding:0}",
      ".PGU_pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);animation:PGU_pulse 1.1s ease-in-out infinite}",
      "@keyframes PGU_pulse{0%,100%{opacity:.25}50%{opacity:1}}",
    ].join("");

    let styleInstalled = false;
    function ensureStyle() {
      if (styleInstalled || typeof document === "undefined") return;
      if (!document.getElementById(STYLE_ID)) {
        const tag = document.createElement("style");
        tag.id = STYLE_ID;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
      styleInstalled = true;
    }

    async function apiGet(pathname) {
      const response = await fetch(API + pathname, { headers: { "x-plugin-guard": "1" }, cache: "no-store" });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: text.slice(0, 200) };
      }
      if (!response.ok) throw new Error((data && data.error) || "HTTP " + response.status);
      return data;
    }

    async function apiPost(pathname, body) {
      const response = await fetch(API + pathname, {
        method: "POST",
        headers: { "x-plugin-guard": "1", "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body || {}),
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: text.slice(0, 200) };
      }
      if (!response.ok) throw new Error((data && data.error) || "HTTP " + response.status);
      return data;
    }

    function statusLabel(status) {
      if (status === "alive") return "存活";
      if (status === "dead") return "疑似失效，需复核";
      if (status === "pending") return "观察中";
      return "未知";
    }

    function statusTone(status) {
      if (status === "alive") return "var(--dsw-alias-state-success-primary)";
      if (status === "dead") return "var(--dsw-alias-state-error-primary)";
      if (status === "pending") return "var(--dsw-alias-state-business-primary)";
      return "var(--dsw-alias-border-l2)";
    }

    function cellStatus(status) {
      if (status === "alive" || status === "dead" || status === "pending") return status;
      return "unknown";
    }

    function fmtTime(iso) {
      if (!iso) return "—";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso);
      const pad = (n) => String(n).padStart(2, "0");
      return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    /** 扫描已运行时长：读 host 的 lastRunResult.startedAt。 */
    function fmtElapsed(payload) {
      const result = payload && payload.lastRunResult ? payload.lastRunResult : null;
      const startedAt = result && result.startedAt ? Date.parse(result.startedAt) : NaN;
      if (!Number.isFinite(startedAt)) return "";
      const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      if (seconds < 60) return "已 " + seconds + " 秒";
      return "已 " + Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒";
    }

    /** 扫描模式的中文名。 */
    function modeLabel(mode) {
      if (mode === "daily") return "每日";
      if (mode === "login") return "登录时";
      if (mode === "manual") return "手动";
      return String(mode || "手动");
    }

    /** 毫秒 → 人类可读的间隔（15000 → 15s，2500 → 2.5s）。 */
    function fmtMs(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return "—";
      const seconds = value / 1000;
      return (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + "s";
    }

    function StatCard(props) {
      return jsx("div", {
        className: "PGU_card",
        children: [
          jsx("div", { className: "PGU_cardLabel", children: props.label }, "l"),
          jsx("div", { className: "PGU_cardValue" + (props.tone ? " " + props.tone : ""), children: props.value }, "v"),
          props.hint ? jsx("div", { className: "PGU_cardHint", children: props.hint }, "h") : null,
        ],
      });
    }

    /** 接管列：待确认时给确认按钮，其余情况只显示结果，避免误点。 */
    function takeoverCell(item, busy, onConfirm) {
      const lt = item && item.lastTakeover ? item.lastTakeover : null;
      if (!lt || typeof lt !== "object") return jsx("span", { className: "PGU_note", children: "—" }, "none");
      const step = String(lt.step || "");
      if (lt.pendingConfirm === true) {
        return jsx("span", { children: [
          jsx("span", { className: "PGU_badge", children: "待确认 " + step }, "pc"),
          jsx("button", { className: "PGU_link", disabled: busy, onClick: () => onConfirm(item, lt), children: "确认接管" }, "cf"),
        ] }, "pend");
      }
      if (lt.ok === true) {
        return jsx("span", {
          className: "PGU_badge",
          title: String(lt.vendor || ""),
          style: { color: "var(--dsw-alias-state-success-primary)", borderColor: "currentColor" },
          children: step === "apply" ? "已接管" : step,
        }, "done");
      }
      if (lt.ok === false) {
        return jsx("span", {
          className: "PGU_badge",
          title: String(lt.error || ""),
          style: { color: "var(--dsw-alias-state-error-primary)", borderColor: "currentColor" },
          children: step + " 失败",
        }, "fail");
      }
      return jsx("span", { className: "PGU_note", children: step || "—" }, "step");
    }

    function GuardPanel() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [reportName, setReportName] = useState(null);
      const [reportBody, setReportBody] = useState(null);

      const load = useCallback(async () => {
        try {
          const next = await apiGet("/state");
          setData(next);
          setError(null);
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      // 轮询节奏来自 host 的 config，缺省回落到 2.5s / 15s。
      const runningPace = data && data.config && Number(data.config.runningPollIntervalMs) > 0 ? Number(data.config.runningPollIntervalMs) : 2500;
      const idlePace = data && data.config && Number(data.config.pollIntervalMs) > 0 ? Number(data.config.pollIntervalMs) : 15000;
      useEffect(() => {
        const interval = data && (data.running || data.stopping) ? runningPace : idlePace;
        const timer = setInterval(load, interval);
        return () => clearInterval(timer);
      }, [load, data && (data.running || data.stopping), runningPace, idlePace]);

      const runScan = useCallback(async () => {
        setBusy(true);
        try {
          const cfg = data && data.config ? data.config : null;
          const body = { mode: cfg && cfg.defaultMode ? cfg.defaultMode : "manual" };
          if (cfg && Number(cfg.probeTimeoutSec) > 0) body.probeTimeoutSec = Math.round(Number(cfg.probeTimeoutSec));
          await apiPost("/run", body);
          await load();
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const stopScan = useCallback(async () => {
        setBusy(true);
        try {
          await apiPost("/stop", {});
          await load();
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const confirmTakeover = useCallback(async (item, lt) => {
        const pkg = item && Array.isArray(item.packages) && item.packages.length > 0 ? String(item.packages[0]) : "";
        const profile = lt && lt.profile
          ? String(lt.profile)
          : (item && Array.isArray(item.profiles) && item.profiles.length > 0 ? String(item.profiles[0]) : "");
        if (!pkg || !profile) {
          setError("这条记录缺少包名或 profile，无法确认接管。");
          return;
        }
        setBusy(true);
        try {
          await apiPost("/takeover", { package: pkg, profile, repo: item.repo });
          await load();
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const openReport = useCallback(async (name) => {
        if (reportName === name) {
          setReportName(null);
          setReportBody(null);
          return;
        }
        setReportName(name);
        setReportBody(null);
        try {
          const payload = await apiGet("/report?name=" + encodeURIComponent(name));
          setReportBody(payload.report);
        } catch (cause) {
          setReportBody({ error: cause && cause.message ? cause.message : String(cause) });
        }
      }, [reportName]);

      const summary = data && data.summary ? data.summary : null;
      const repos = data && Array.isArray(data.repos) ? data.repos : [];
      const reports = data && Array.isArray(data.reports) ? data.reports : [];
      const snapshots = data && Array.isArray(data.snapshots) ? data.snapshots : [];
      const runTail = data && data.lastRunResult && data.lastRunResult.tail ? data.lastRunResult.tail.trim() : "";

      const head = jsx("div", { className: "PGU_head", children: [
        jsx("div", { children: [
          jsx("h3", { className: "PGU_title", children: "上游守护" }, "t"),
          jsx("p", { className: "PGU_sub", children: data ? data.guardDir : "~/.dsh/plugin-guard" }, "s"),
          data && data.config
            ? jsx("div", { className: "PGU_cfg", children: [
                jsx("span", { className: "PGU_cfgItem", children: "模式 " + modeLabel(data.config.defaultMode) }, "m"),
                jsx("span", { className: "PGU_cfgItem", children: "探测超时 " + data.config.probeTimeoutSec + "s" }, "p"),
                jsx("span", { className: "PGU_cfgItem", children: "硬超时 " + Math.round(Number(data.config.runTimeoutMs || 0) / 60000) + " 分钟" }, "t"),
                jsx("span", { className: "PGU_cfgItem", children: "轮询 " + fmtMs(data.config.pollIntervalMs) + " / 运行中 " + fmtMs(data.config.runningPollIntervalMs) }, "i"),
                jsx("span", { className: "PGU_cfgItem", children: "范围 " + data.config.guardProfiles }, "g"),
                data.config.takeover
                  ? jsx("span", { className: "PGU_cfgItem", children: "接管 " + data.config.takeover.mode + " · ≥" + data.config.takeover.confirmRuns + " 次 / " + data.config.takeover.minHours + "h" }, "tk")
                  : null,
                data.takeoverLedger && data.takeoverLedger.circuitOpenAt
                  ? jsx("span", { className: "PGU_cfgItem", "data-warn": "true", children: "接管已熔断（连续失败 " + (data.takeoverLedger.consecutiveFailures || 0) + " 次，复位后恢复）" }, "brk")
                  : null,
                data.takeoverLedger && Number(data.takeoverLedger.appliedInWindow || 0) > 0
                  ? jsx("span", { className: "PGU_cfgItem", children: "24h 已接管 " + data.takeoverLedger.appliedInWindow + "/" + ((data.config.takeover && data.config.takeover.maxTotal) || "∞") }, "bud")
                  : null,
                data.config.allowActions === false
                  ? jsx("span", { className: "PGU_cfgItem", "data-warn": "true", children: "面板操作已禁用（allowActions: false）" }, "lock")
                  : null,
                jsx("span", { className: "PGU_cfgItem", children: data.config.enableSnapshots ? "源码快照：已启用" : "源码快照：关闭（需显式配置）" }, "snapcfg"),
                data.config.hasSchema === false
                  ? jsx("span", { className: "PGU_cfgItem", "data-warn": "true", children: "schema 未加载，使用内置默认值" }, "ns")
                  : null,
              ] }, "cfg")
            : null,
        ] }, "lt"),
        jsx("div", { className: "PGU_actions", children: [
          data && (data.running || data.stopping)
            ? jsx("span", { className: "PGU_note", children: [jsx("span", { className: "PGU_pulse" }, "p"), (data.stopping ? " 正在停止 " : " 扫描进行中 ") + fmtElapsed(data)] }, "run")
            : null,
          data && (data.running || data.stopping)
            ? jsx("button", { className: "PGU_btn", "data-kind": "danger", onClick: stopScan, disabled: busy, children: "停止" }, "stop")
            : null,
          jsx("button", { className: "PGU_btn", onClick: load, disabled: busy, children: "刷新" }, "r"),
          jsx("button", {
            className: "PGU_btn",
            "data-kind": "primary",
            onClick: runScan,
            disabled: busy || Boolean(data && data.config && data.config.allowActions === false) || Boolean(data && (data.running || data.stopping)),
            children: data && (data.running || data.stopping) ? (data.stopping ? "正在停止" : "扫描中") : "扫描并生成报告",
          }, "go"),
        ] }, "ac"),
      ] }, "head");

      const cards = summary && data && data.ok
        ? jsx("div", { className: "PGU_cards", children: [
            jsx(StatCard, { label: "上游仓库", value: summary.repos, hint: summary.packages + " 个包 · " + (summary.profiles || 0) + " 个 profile" }, "c1"),
            jsx(StatCard, { label: "存活", value: summary.alive, tone: "PGU_tone-ok", hint: "仅端点响应；上游缺失 " + (summary.upstreamMissing || 0) + " 个" }, "c2"),
            jsx(StatCard, {
              label: "异常 / 待确认",
              value: summary.dead + summary.pending,
              tone: summary.dead > 0 ? "PGU_tone-bad" : summary.pending > 0 ? "PGU_tone-warn" : "PGU_tone-ok",
              hint: summary.confirmed > 0 ? summary.confirmed + " 个需人工复核（未接管）" : "仅报告，不自动改依赖或接管",
            }, "c3"),
            jsx(StatCard, {
              label: "本地快照",
              value: summary.snapshots,
              tone: summary.emptySnapshots > 0 ? "PGU_tone-warn" : "",
              hint: summary.emptySnapshots > 0 ? summary.emptySnapshots + " 个空快照需重建" : "源码副本；依赖与恢复能力需另验",
            }, "c4"),
          ] }, "cards")
        : null;

      const matrix = repos.length > 0
        ? jsx("div", { className: "PGU_matrix", children: repos.map((item) =>
            jsx("div", {
              key: item.repo,
              className: "PGU_cell",
              "data-s": cellStatus(item.status),
              title: item.repo + " · " + statusLabel(item.status) + " · " + (item.profiles.length > 0 ? item.profiles.join("/") : "未挂载"),
            }, item.repo)) }, "matrix")
        : null;

      const table = repos.length > 0
        ? jsx("div", { children: [
            jsx("p", { className: "PGU_sectionTitle", children: "仓库明细" }, "st"),
            jsx("table", { className: "PGU_table", children: [
              jsx("thead", { children: jsx("tr", { children: [
                jsx("th", { children: "仓库" }, "h1"),
                jsx("th", { children: "状态" }, "h2"),
                jsx("th", { children: "包 / profile" }, "h3"),
                jsx("th", { children: "兜底" }, "h4"),
                jsx("th", { children: "最后探测" }, "h5"),
                jsx("th", { children: "接管" }, "h6"),
              ] }, "hr") }, "thead"),
              jsx("tbody", { children: repos.map((item) => {
                const pkgText = item.packages.length > 1
                  ? item.packages[0] + " +" + (item.packages.length - 1)
                  : (item.packages[0] || "—");
                return jsx("tr", { key: item.repo, children: [
                  jsx("td", { className: "PGU_mono", children: item.repo }, "d1"),
                  jsx("td", { className: "PGU_state", children: [
                    jsx("span", { className: "PGU_dot", style: { background: statusTone(item.status) } }, "dot"),
                    statusLabel(item.status),
                    item.consecutiveDead > 0 ? jsx("span", { className: "PGU_badge", children: "连败 " + item.consecutiveDead }, "cd") : null,
                  ] }, "d2"),
                  jsx("td", { children: [
                    jsx("span", { className: "PGU_mono", children: pkgText }, "pk"),
                    jsx("span", { className: "PGU_pkg", children: item.profiles.length > 0 ? item.profiles.join(" · ") : "未挂载" }, "pf"),
                  ] }, "d3"),
                  jsx("td", { children: jsx("span", {
                    className: "PGU_badge",
                    style: /ok/i.test(String(item.npm)) ? { color: "var(--dsw-alias-state-success-primary)", borderColor: "currentColor" } : null,
                  }, String(item.npm || "无") ) }, "d4"),
                  jsx("td", { className: "PGU_mono", children: fmtTime(item.lastProbe) }, "d5"),
                  jsx("td", { className: "PGU_state", children: takeoverCell(item, busy, confirmTakeover) }, "d6"),
                ] }, item.repo);
              }) }, "tbody"),
            ] }, "tbl"),
          ] }, "table")
        : null;

      const runBlock = (data && (data.running || data.stopping)) || runTail !== ""
        ? jsx("div", { children: [
            jsx("p", { className: "PGU_sectionTitle", children: "最近一次运行的输出" }, "rt"),
            jsx("pre", { className: "PGU_pre", children: runTail !== "" ? runTail : "（等待输出…）" }, "pre"),
          ] }, "run")
        : null;

      const reportBlock = reports.length > 0
        ? jsx("div", { children: [
            jsx("p", { className: "PGU_sectionTitle", children: "历史报告（最近 " + reports.length + " 份）" }, "rpt"),
            ...reports.map((item) => jsx("div", { key: item.name, className: "PGU_reportRow", children: [
              jsx("span", { className: "PGU_mono", children: item.at }, "ra"),
              jsx("span", { className: "PGU_note", children: (item.size / 1024).toFixed(1) + " KB" }, "rs"),
              jsx("button", { className: "PGU_link", onClick: () => openReport(item.name), children: reportName === item.name ? "收起" : "查看" }, "rb"),
            ] }, item.name)),
            reportName && reportBody
              ? jsx("pre", { className: "PGU_pre", style: { marginTop: "8px" }, children: JSON.stringify(reportBody, null, 2) }, "rbody")
              : null,
          ] }, "reports")
        : null;

      const snapshotBlock = snapshots.length > 0
        ? jsx("div", { children: [
            jsx("p", { className: "PGU_sectionTitle", children: "本地快照" }, "sst"),
            jsx("div", { className: "PGU_chips", children: snapshots.map((item) =>
              jsx("span", {
                key: item.name,
                className: "PGU_chip",
                "data-empty": String(item.empty),
                title: item.layout === "legacy" ? "旧布局：未校验，不自动迁移或删除" : "源码副本；当前完整性未重新校验，不代表可离线安装",
                children: item.name + " · " + item.files + " 文件" + (item.layout === "legacy" ? " · 旧布局未校验" : ""),
              }, item.name)) }, "chips"),
          ] }, "snaps")
        : null;

      return jsx("div", { className: "PGU_root", children: [
        head,
        data && data.warning ? jsx("p", { className: "PGU_err", children: data.warning }, "state-warning") : null,
        error ? jsx("div", { className: "PGU_err", children: error }, "err") : null,
        !data && !error ? jsx("p", { className: "PGU_note", children: "正在读取守护状态…" }, "loading") : null,
        cards,
        matrix,
        table,
        runBlock,
        reportBlock,
        snapshotBlock,
        data && data.lastRun
          ? jsx("p", { className: "PGU_note", children: "计划任务上次运行：" + fmtTime(data.lastRun) + "（mode=" + String(data.lastMode || "?") + "）" }, "lr")
          : null,
      ] }, "root");
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "plugin-guard",
            order: 18,
            label: () => "上游守护",
          },
          GuardPanel,
        ),
      );
    }

    exports.NS = NS;
    exports.inject = inject;
    exports.apply = apply;
    exports.GuardPanel = GuardPanel;
    return module.exports;
  },
});
