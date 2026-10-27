// probe_routes.js —— 判断每个源「本机直连」还是「Worker 中转」，生成中转名单
//
// ⚠️ 必须在**国内网络**的本机跑。GitHub Actions 跑出来的是海外视角，
//    测不出国内 DNS 污染/墙，所以中转名单只认本机结果，CI 不会覆盖它。
//
// 用法：
//   node probe_routes.js                # 只生成名单和报告
//   node probe_routes.js --push         # 生成后自动 commit + push（一键上传）
//   node probe_routes.js https://你的worker  # 换中转地址
//
// 判定规则（均为本机真实网络，强制不走本机代理）：
//   - 直连 3 次里有 1 次失败/被 CF 挑战 → 走中转（DNS 污染是间歇性的，不能单次采信）
//   - 直连能通但比中转慢 1.5× 以上，或慢过 1800ms → 走中转
//   - 中转也失败、直连也失败 → 标记「都不通」，不加前缀（加了也没用）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const axios = require("axios");

const CONFIG_PATH = path.join(__dirname, "LunaTV-config.json");
const REPORT_PATH = path.join(__dirname, "route-report.md");
const ROUTES_PATH = path.join(__dirname, "proxy-routes.json");

const argv = process.argv.slice(2);
const SHOULD_PUSH = argv.includes("--push");
const WORKER_ARG = argv.find((a) => a.startsWith("http"));
const WORKER = (WORKER_ARG || process.env.WORKER || "https://xiaoxia.dpdns.org").replace(/\/+$/, "");

const SAMPLES = 3;          // 直连采样次数：任一失败即判「需要中转」
const CONCURRENCY = 10;
const TIMEOUT_MS = 8000;
const SLOWER_RATIO = 1.5;
const SLOW_ABS_MS = 1800;

// 本机视角：绝不允许走本机代理，否则测出来的是海外结果
// maxRedirects: axios 默认不跟随 301/302；很多 CMS 源会 301 到带斜杠的地址
const DIRECT_AXIOS = { proxy: false, timeout: TIMEOUT_MS, validateStatus: () => true, maxRedirects: 5 };

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const CHALLENGE = [
  /Just a moment/i, /cf-chl-/i, /challenges\.cloudflare\.com/i,
  /Attention Required! \| Cloudflare/i, /Checking your browser/i,
];

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

const stripProxy = (api) => {
  const i = api.indexOf("?url=");
  return i === -1 ? api : api.slice(i + 5);
};

// 判断返回内容是不是「真数据」：JSON 或 XML 才算，返回网站首页 HTML 的等于源坏了
const classifyBody = (data, headers) => {
  let text = typeof data === "string" ? data : JSON.stringify(data);
  if (typeof text !== "string") return "empty";
  const head = text.trim().slice(0, 400);
  if (!head) return "empty";
  const ct = String((headers && (headers["content-type"] || headers["Content-Type"])) || "");
  if (/json/i.test(ct) || head.startsWith("{") || head.startsWith("[")) return "json";
  if (/^<\?xml/i.test(head) || /^<rss/i.test(head) || /^<\?xml[^>]*\?>/i.test(head)) return "xml";
  // 停放/待售页：域名卖掉了，返回 200 但没有数据
  if (/domain (is )?for sale|buy this domain|_parked|parkingcrew|sedoparking|域名出售/i.test(text.slice(0, 3000))) {
    return "parked";
  }
  if (/<!doctype html|<html|<head|<body/i.test(head)) return "html";  // 首页/跳转页，不是接口数据
  return "other";
};

// 单次探测
const probeOnce = async (url) => {
  const t0 = Date.now();
  try {
    const res = await axios.get(url, { ...DIRECT_AXIOS, headers: BROWSER_HEADERS });
    const ms = Date.now() - t0;
    let body = res.data;
    if (body && typeof body === "object") body = JSON.stringify(body);
    const blocked = typeof body === "string" && CHALLENGE.some((re) => re.test(body.slice(0, 3000)));
    const kind = res.status === 200 ? classifyBody(res.data, res.headers) : "http";
    const valid = kind === "json" || kind === "xml";
    const ok = res.status === 200 && !blocked && valid;
    let error = null;
    if (!ok) {
      if (blocked) error = "CF_CHALLENGE";
      else if (res.status !== 200) error = `HTTP_${res.status}`;
      else if (kind === "parked") error = "域名待售/停放页";
      else if (kind === "html") error = "返回网页而非 API 数据";
      else error = `无效内容(${kind})`;
    }
    return { ok, status: res.status, ms, blocked, kind, error };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, blocked: false, kind: "err", error: e.code || e.message };
  }
};

// 多次采样（直连用）：任一失败就算不稳定
const probeMulti = async (url, samples) => {
  const runs = [];
  for (let i = 0; i < samples; i++) {
    runs.push(await probeOnce(url));
    if (i < samples - 1) await new Promise((r) => setTimeout(r, 400));
  }
  const okRuns = runs.filter((r) => r.ok);
  const failed = runs.filter((r) => !r.ok);
  const bestMs = okRuns.length ? Math.min(...okRuns.map((r) => r.ms)) : Math.min(...runs.map((r) => r.ms));
  return {
    runs,
    okCount: okRuns.length,
    failCount: failed.length,
    bestMs,
    anyOk: okRuns.length > 0,
    errors: [...new Set(failed.map((r) => r.error).filter(Boolean))],
  };
};

const queue = async (items, limit, fn) => {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
};

(async () => {
  const entries = Object.entries(config.api_site).filter(([, s]) => !s.disabled);
  console.log(`⏳ 本机视角探测 ${entries.length} 个源（每源直连 ${SAMPLES} 次，不走本机代理）`);
  console.log(`   中转地址: ${WORKER}`);

  const rows = await queue(entries, CONCURRENCY, async ([key, site]) => {
    const direct = stripProxy(site.api);
    // 带 _comment=直连 的源：中转对它无效（如奥斯卡返回 520），永远不加前缀
    const forceDirect = /直连/.test(String(site._comment || ""));
    let host = key;
    try { host = new URL(direct).host.toLowerCase(); } catch {}

    // 探针必须是裸 API 地址（.../api.php/provide/vod）。
    // 不能带 ?wd= 之类的搜索参数：很多源不支持搜索，会返回 503 / HTML / 「暂不支持搜索」，
    // 那样判出来的「源挂了」是假的。搜索能力由 check_api.js 单独测。
    const workerUrl = `${WORKER}/?url=${encodeURIComponent(direct)}`;

    const [d, w] = await Promise.all([
      probeMulti(direct, SAMPLES),
      probeMulti(workerUrl, 1),
    ]);
    return { key, host, name: site.name, direct, d, w, forceDirect };
  });

  const results = rows.map((r) => {
    const workerOk = r.w.anyOk;
    let verdict, reason;

    if (r.forceDirect) {
      verdict = "直连";
      reason = "标了直连（中转对此源无效）";
    } else if (r.d.failCount > 0 && workerOk) {
      verdict = "中转";
      const why = r.d.anyOk ? `${r.d.failCount}/${SAMPLES} 次直连失败（时通时断）` : "本机直连不通";
      reason = r.d.errors.length ? `${why}：${r.d.errors.slice(0, 2).join("/")}` : why;
    } else if (r.d.failCount > 0 && !workerOk) {
      verdict = "都不通";
      const why = (r.d.errors || []).concat(r.w.errors || []).filter(Boolean);
      const parked = why.includes("域名待售/停放页");
      const htmls = why.includes("返回网页而非 API 数据");
      reason = parked ? "域名待售/停放页（源已失效）"
        : htmls ? "返回网页而非 API 数据（接口已改）"
        : (why.length ? `直连和中转都失败：${why.slice(0, 2).join("/")}` : "直连和中转都失败");
    } else if (!workerOk) {
      verdict = "直连";
      reason = "中转失败，直连正常";
    } else {
      const ratio = r.d.bestMs / Math.max(r.w.bestMs, 1);
      if (ratio >= SLOWER_RATIO) { verdict = "中转"; reason = `直连慢 ${ratio.toFixed(1)}×（${r.d.bestMs}ms vs ${r.w.bestMs}ms）`; }
      else if (r.d.bestMs >= SLOW_ABS_MS) { verdict = "中转"; reason = `直连 ${r.d.bestMs}ms 偏慢`; }
      else { verdict = "直连"; reason = `直连 ${r.d.bestMs}ms 更快`; }
    }
    return { ...r, verdict, reason };
  });

  const useProxy = results.filter((r) => r.verdict === "中转");
  const bothFail = results.filter((r) => r.verdict === "都不通");

  // === 报告 ===
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " CST";
  const md = [
    "# 直连 / 中转 链路对比（本机国内视角）",
    "",
    `- 生成时间：${stamp}`,
    `- 探测位置：**本机国内网络**（强制不走本机代理）。海外机房测不出 DNS 污染，所以这份名单只能本机生成。`,
    `- 中转地址：${WORKER}`,
    `- 判定：直连 ${SAMPLES} 次里任一失败即走中转；都通则比速度`,
    `- 结论：**${results.length} 个源 → 走中转 ${useProxy.length} 个 / 直连 ${results.length - useProxy.length - bothFail.length} 个 / 都不通 ${bothFail.length} 个**`,
    "",
    "| 建议 | 资源名称 | 直连成功率 | 中转 | 直连最优 | 中转 | 说明 |",
    "|---|---|---|---|---:|---:|---|",
    ...results
      .sort((a, b) => {
        const rank = { 中转: 0, 都不通: 1, 直连: 2 };
        return rank[a.verdict] - rank[b.verdict] || a.name.localeCompare(b.name);
      })
      .map((r) => `| ${r.verdict} | ${r.name} | ${r.d.okCount}/${SAMPLES} | ${r.w.anyOk ? "✅" : "❌"} | ${r.d.bestMs}ms | ${r.w.bestMs}ms | ${r.reason} |`),
    "",
  ].join("\n");
  fs.writeFileSync(REPORT_PATH, md, "utf-8");

  // === 给 Worker 的名单 ===
  const routes = {
    generated: stamp,
    source: "local-cn",          // 标记：本机国内探测，CI 不要覆盖
    worker: WORKER,
    proxy: Object.fromEntries(useProxy.map((r) => [r.host, r.reason])),
    dead: bothFail.map((r) => r.host),
  };
  fs.writeFileSync(ROUTES_PATH, JSON.stringify(routes, null, 2) + "\n", "utf-8");

  console.log(`✅ 报告: ${path.basename(REPORT_PATH)} | 名单: ${path.basename(ROUTES_PATH)}`);
  console.log(`   走中转 ${useProxy.length} 个 | 直连 ${results.length - useProxy.length - bothFail.length} 个 | 都不通 ${bothFail.length} 个`);
  if (useProxy.length) {
    console.log("   进名单的源：");
    for (const r of useProxy) console.log(`     - ${r.name}（${r.host}）：${r.reason}`);
  }

  // === 一键上传 ===
  if (!SHOULD_PUSH) {
    console.log("\n💡 想一键上传：node probe_routes.js --push");
    return;
  }

  const GIT_PROXY = process.env.GIT_PROXY || "http://127.0.0.1:7897";
  const GCM = process.env.GCM_PATH ||
    "C:/Users/xiaoling/.dsh/profiles/desktop/node_modules/@dsh-ops/bash-win32-x64/ucrt64/bin/git-credential-manager.exe";

  const run = (args, extraEnv = {}) => execFileSync("git", args, {
    cwd: __dirname,
    encoding: "utf8",
    env: { ...process.env, GCM_INTERACTIVE: "never", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const stampMsg = `更新中转名单（本机 ${stamp}，走中转 ${useProxy.length} 个）`;
  try {
    console.log("\n⏳ 提交并推送名单…");
    run(["add", "proxy-routes.json", "route-report.md"]);
    try { run(["commit", "-m", stampMsg]); } catch { console.log("   （没有变化，跳过提交）"); }
    run(["-c", "credential.helper=", "-c", `credential.helper=${GCM}`, "push", "origin", "main"], {
      HTTPS_PROXY: GIT_PROXY, HTTP_PROXY: GIT_PROXY,
    });
    console.log("✅ 已推送。Worker 下次请求就会读到新名单（KV 缓存 30 分钟，最多等半小时）");
  } catch (err) {
    console.error("❌ 推送失败：", (err.stderr || err.message || "").toString().slice(0, 400));
    console.error("   可手动执行：git add proxy-routes.json route-report.md && git commit -m \"" + stampMsg + "\" && git push");
    process.exitCode = 1;
  }
})();
