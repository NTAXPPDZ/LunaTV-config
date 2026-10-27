// probe_routes.js —— 判断每个源「本机直连」还是「Worker 中转」更快/更通
//
// 用法：
//   node probe_routes.js                       # 用默认中转地址
//   node probe_routes.js https://你的worker域名  # 指定自己的 Worker
//   WORKER=https://xiaoxia.dpdns.org node probe_routes.js
//
// 产出：
//   route-report.md     人看的对比表（带推荐）
//   proxy-routes.json   Worker 用：只对名单里的源加中转前缀（format=1&mode=mixed）
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CONFIG_PATH = path.join(__dirname, "LunaTV-config.json");
const REPORT_PATH = path.join(__dirname, "route-report.md");
const ROUTES_PATH = path.join(__dirname, "proxy-routes.json");

const WORKER = (process.argv[2] || process.env.WORKER || "https://xiaoxia.dpdns.org").replace(/\/+$/, "");
const SAMPLES = 2;             // 每条链路采样次数（取最快值，避开抖动）
const CONCURRENCY = 8;
const TIMEOUT_MS = 10000;
// 直连比中转慢这么多倍，就判定「走中转」
const SLOWER_RATIO = 1.5;
// 直连慢过这个绝对值也建议走中转（ms）
const SLOW_ABS_MS = 1800;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const CHALLENGE = [/Just a moment/i, /cf-chl-/i, /challenges\.cloudflare\.com/i, /Attention Required! \| Cloudflare/i, /Checking your browser/i];

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// 配置里已经是中转形式的源，还原成裸地址再比
const stripProxy = (api) => {
  const i = api.indexOf("?url=");
  return i === -1 ? api : api.slice(i + 5);
};
const withQuery = (base, wd) => `${base}${base.includes("?") ? "&" : "?"}wd=${encodeURIComponent(wd)}`;

const probeOnce = async (url) => {
  const t0 = Date.now();
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: BROWSER_HEADERS,
      validateStatus: () => true,
    });
    const ms = Date.now() - t0;
    let body = res.data;
    if (body && typeof body === "object") body = JSON.stringify(body);
    const isChallenge = typeof body === "string" && CHALLENGE.some((re) => re.test(body.slice(0, 3000)));
    return { ok: res.status === 200 && !isChallenge, status: res.status, ms, blocked: isChallenge };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.code || "ERR" };
  }
};

const probe = async (url) => {
  const runs = [];
  for (let i = 0; i < SAMPLES; i++) runs.push(await probeOnce(url));
  const best = runs.filter((r) => r.ok).sort((a, b) => a.ms - b.ms)[0];
  if (best) return { ...best, ok: true };
  return runs.sort((a, b) => a.status - b.status)[0];
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
  console.log(`⏳ 对比 ${entries.length} 个源的「直连 vs 中转」，中转: ${WORKER}`);

  const rows = await queue(entries, CONCURRENCY, async ([key, site]) => {
    const direct = stripProxy(site.api);
    // 白名单按「API 域名」记，Worker 里按 host 精确匹配
    let host = key;
    try { host = new URL(direct).host.toLowerCase(); } catch {}
    const viaWorker = `${WORKER}/?url=${encodeURIComponent(direct)}`;
    // 用搜索请求比，链路差异才明显（首页可能被缓存）
    const [d, w] = await Promise.all([probe(withQuery(direct, "你好")), probe(withQuery(viaWorker, "你好"))]);
    return { key, host, name: site.name, direct, d, w };
  });

  const results = rows.map((r) => {
    const dOk = r.d.ok, wOk = r.w.ok;
    let verdict, reason;
    if (dOk && !wOk) { verdict = "直连"; reason = "中转失败"; }
    else if (!dOk && wOk) { verdict = "中转"; reason = "直连失败/被挡"; }
    else if (!dOk && !wOk) { verdict = "都不通"; reason = "两条路都失败"; }
    else {
      const ratio = r.d.ms / Math.max(r.w.ms, 1);
      if (ratio >= SLOWER_RATIO) { verdict = "中转"; reason = `直连慢 ${ratio.toFixed(1)}×`; }
      else if (r.d.ms >= SLOW_ABS_MS) { verdict = "中转"; reason = `直连 ${r.d.ms}ms 偏慢`; }
      else { verdict = "直连"; reason = `直连 ${r.d.ms}ms 更快`; }
    }
    return { ...r, verdict, reason };
  });

  // === 报告 ===
  const useProxy = results.filter((r) => r.verdict === "中转");
  const md = [
    "# 直连 / 中转 链路对比",
    "",
    `- 生成时间：${new Date(Date.now() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16)} CST`,
    `- 中转地址：${WORKER}`,
    `- 判定规则：直连失败或比中转慢 ${SLOWER_RATIO}× 以上 → 走中转`,
    `- 结论：**${results.length} 个源里 ${useProxy.length} 个建议走中转，${results.length - useProxy.length} 个直连即可**`,
    "",
    "| 建议 | 资源名称 | 直连 | 中转 | 直连耗时 | 中转耗时 | 说明 |",
    "|---|---|---|---|---:|---:|---|",
    ...results
      .sort((a, b) => (a.verdict === b.verdict ? a.name.localeCompare(b.name) : a.verdict.localeCompare(b.verdict)))
      .map((r) => `| ${r.verdict} | ${r.name} | ${r.d.ok ? "✅" : (r.d.blocked ? "🛡" : "❌")} | ${r.w.ok ? "✅" : (r.w.blocked ? "🛡" : "❌")} | ${r.d.ms}ms | ${r.w.ms}ms | ${r.reason} |`),
    "",
  ].join("\n");
  fs.writeFileSync(REPORT_PATH, md, "utf-8");

  // === 给 Worker 用的名单 ===
  const routes = {
    generated: new Date(Date.now() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " CST",
    worker: WORKER,
    // 只有这些源在 format=1&mode=mixed / format=4 时会被加中转前缀
    proxy: Object.fromEntries(useProxy.map((r) => [r.host, r.reason])),
  };
  fs.writeFileSync(ROUTES_PATH, JSON.stringify(routes, null, 2), "utf-8");

  console.log(`✅ 报告: ${path.basename(REPORT_PATH)} | 名单: ${path.basename(ROUTES_PATH)}`);
  console.log(`   建议走中转 ${useProxy.length} 个 / 直连 ${results.length - useProxy.length} 个 / 都不通 ${results.filter(r => r.verdict === "都不通").length} 个`);
  const fastest = results.filter(r => r.verdict === "中转").slice(0, 5);
  if (fastest.length) {
    console.log("   走中转的源示例：");
    for (const r of fastest) console.log(`     - ${r.name}：${r.reason}`);
  }
})();
