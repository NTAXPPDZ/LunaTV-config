// check_api.js —— 源接口健康检测（队列并发 + 重试 + 浏览器头 + CF 挑战识别）
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "LunaTV-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const MAX_DAYS = 30;
const WARN_STREAK = 3;
const ENABLE_SEARCH_TEST = true;
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10; // 并发限制
const MAX_RETRY = 3;         // 请求最大重试次数
const RETRY_DELAY_MS = 500;  // 重试间隔(ms)

// 伪装成浏览器：很多源/中转会拦 axios 默认 UA，返回 Cloudflare 人机验证页
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

// Cloudflare / WAF 挑战特征（不是源挂了，是被挡在门外）
const CHALLENGE_PATTERNS = [
  /Just a moment\.\.\./i,
  /cf-chl-/i,
  /challenges\.cloudflare\.com/i,
  /Attention Required! \| Cloudflare/i,
  /Checking your browser/i,
  /<title>\s*Just a moment/i,
];

const looksLikeChallenge = (res) => {
  const h = res.headers || {};
  if (String(h["cf-mitigated"] || "").toLowerCase() === "challenge") return true;
  const ct = String(h["content-type"] || "");
  let body = res.data;
  if (body && typeof body === "object") {
    body = JSON.stringify(body);
  }
  if (typeof body !== "string") return false;
  // 真 JSON 就不是挑战页
  if (ct.includes("json") && body.trim().startsWith("{")) return false;
  return CHALLENGE_PATTERNS.some((re) => re.test(body.slice(0, 4000)));
};

// === 加载配置 ===
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ 配置文件不存在:", CONFIG_PATH);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const apiEntries = Object.values(config.api_site).map((s) => ({
  name: s.name,
  api: s.api,
  detail: s.detail || "-",
  disabled: !!s.disabled,
}));

// === 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
  const old = fs.readFileSync(REPORT_PATH, "utf-8");
  const match = old.match(/```json\r?\n([\s\S]+?)\r?\n```/);
  if (match) {
    try {
      history = JSON.parse(match[1]);
    } catch {}
  }
}

// === 当前 CST 时间 ===
const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 16) + " CST";

// === 工具函数（带重试） ===
const delay = ms => new Promise(r => setTimeout(r, ms));

// 返回 { ok, status, blocked, ms }
const probe = async (url) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const started = Date.now();
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: BROWSER_HEADERS,
        validateStatus: () => true, // 403 也要拿到内容，才能判断是不是挑战页
      });
      const ms = Date.now() - started;
      if (looksLikeChallenge(res)) {
        return { ok: false, status: res.status, blocked: true, ms };
      }
      return { ok: res.status === 200, status: res.status, blocked: false, ms };
    } catch (err) {
      const ms = Date.now() - started;
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return { ok: false, status: 0, blocked: false, ms, error: err.code || err.message };
    }
  }
};

const testSearch = async (api, keyword) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const url = `${api}${api.includes("?") ? "&" : "?"}wd=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: BROWSER_HEADERS,
        validateStatus: () => true,
      });
      if (looksLikeChallenge(res)) return "🛡";
      if (res.status !== 200 || !res.data || typeof res.data !== "object") return "❌";
      const list = res.data.list || [];
      if (!list.length) return "无结果";
      return list.some(item => JSON.stringify(item).includes(keyword)) ? "✅" : "不匹配";
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return "❌";
    }
  }
};

// === 队列并发执行函数 ===
const queueRun = (tasks, limit) => {
  let index = 0;
  let active = 0;
  const results = [];

  return new Promise(resolve => {
    const next = () => {
      while (active < limit && index < tasks.length) {
        const i = index++;
        active++;
        tasks[i]().then(res => results[i] = res)
                  .catch(err => results[i] = { error: err })
                  .finally(() => {
                    active--;
                    next();
                  });
      }

      if (index >= tasks.length && active === 0) resolve(results);
    };

    next();
  });
};

// === 主逻辑 ===
(async () => {
  console.log("⏳ 正在检测 API 与搜索功能可用性（队列并发 + 重试 + 浏览器头）...");

  const tasks = apiEntries.map(({ name, api, disabled }) => async () => {
    if (disabled) return { name, api, disabled, success: false, blocked: false, searchStatus: "无法搜索", ms: 0 };

    const r = await probe(api);
    const searchStatus = ENABLE_SEARCH_TEST ? await testSearch(api, SEARCH_KEYWORD) : "-";
    return { name, api, disabled, success: r.ok, blocked: !!r.blocked, searchStatus, ms: r.ms };
  });

  const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);

  const todayRecord = {
    // 用 CST（UTC+8）日期，避免凌晨 0-8 点被记成前一天
    date: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10),
    keyword: SEARCH_KEYWORD,
    results: todayResults,
  };

  history.push(todayRecord);
  if (history.length > MAX_DAYS) history = history.slice(-MAX_DAYS);

  // === 统计和生成报告 ===
  const stats = {};
  for (const { name, api, detail, disabled } of apiEntries) {
    stats[api] = { name, api, detail, disabled, ok: 0, fail: 0, blocked: 0, fail_streak: 0, trend: "", searchStatus: "-", status: "❌" };

    for (const day of history) {
      const rec = (day.results || []).find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) stats[api].ok++;
      else {
        stats[api].fail++;
        if (rec.blocked) stats[api].blocked++;
      }
    }

    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const rec = (history[i].results || []).find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) break;
      streak++;
    }
    const total = stats[api].ok + stats[api].fail;
    stats[api].successRate = total > 0 ? ((stats[api].ok / total) * 100).toFixed(1) + "%" : "-";

    const recent = history.slice(-7);
    stats[api].trend = recent.map(day => {
      const r = (day.results || []).find(x => x.api === api);
      return r ? (r.success ? "✅" : (r.blocked ? "🛡" : "❌")) : "-";
    }).join("");

    const latest = todayResults.find(x => x.api === api);
    if (latest) {
      stats[api].searchStatus = latest.searchStatus;
      stats[api].ms = latest.ms;
    }

    // 状态优先级：停用 > 连续失败 > 今天被 CF 挑战 > 今天成功 > 失败
    if (disabled) stats[api].status = "🚫";
    else if (latest?.success) stats[api].status = "✅";
    else if (latest?.blocked) stats[api].status = "🛡";
    else if (streak >= WARN_STREAK) stats[api].status = "🚨";
  }

  // === 生成 Markdown 报告 ===
  let md = `# 源接口健康检测报告\n\n`;
  md += `最近更新时间：${now}\n\n`;
  md += `**总源数:** ${apiEntries.length} | **检测关键词:** ${SEARCH_KEYWORD}\n\n`;
  md += "> 🛡 = 被 Cloudflare/WAF 人机验证挡住（源本身可能没坏，浏览器里能打开）\n\n";
  md += "| 状态 | 资源名称 | 地址 | API | 搜索功能 | 成功次数 | 失败次数 | 成功率 | 最近7天趋势 |\n";
  md += "|------|---------|-----|-----|---------|---------:|--------:|-------:|--------------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "🛡": 3, "✅": 4, "🚫": 5 };
    return (order[a.status] || 9) - (order[b.status] || 9);
  });

  for (const s of sorted) {
    const detailLink = s.detail.startsWith("http") ? `[Link](${s.detail})` : s.detail;
    const apiLink = `[Link](${s.api})`;
    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  }

  md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
  md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
  md += `</details>\n`;

  fs.writeFileSync(REPORT_PATH, md, "utf-8");

  const blockedToday = todayResults.filter(r => r.blocked).length;
  console.log("📄 报告已生成:", REPORT_PATH);
  console.log(`   ✅ 成功 ${todayResults.filter(r => r.success).length} | 🛡 CF挑战 ${blockedToday} | ❌ 失败 ${todayResults.filter(r => !r.success && !r.blocked).length}`);
})();
