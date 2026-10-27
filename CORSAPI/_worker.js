// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // KV 绑定名兼容：KV / CONFIG_KV / CONFIG_CACHE 都认（文档以前写 CONFIG_KV，代码只读 KV，导致按文档配了却没用）
    if (env && typeof globalThis.KV === 'undefined') {
      const candidate = env.KV || env.CONFIG_KV || env.CONFIG_CACHE
      if (candidate && typeof candidate.get === 'function') {
        globalThis.KV = candidate
      }
    }

    return handleRequest(request, env)
  }
}

// 常量配置（避免重复创建）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

// 订阅源地址（fork 后改成你自己仓库的 raw 地址）
const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/NTAXPPDZ/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/NTAXPPDZ/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/NTAXPPDZ/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

// 混合中转白名单：由 probe_routes.js 实测生成，只给这些源加中转前缀
// 格式映射 { 裸 API 域名: 原因 }，可在 Worker 环境变量 PROXY_ROUTES(JSON) 里覆盖
const ROUTE_FILE = 'https://raw.githubusercontent.com/NTAXPPDZ/LunaTV-config/refs/heads/main/proxy-routes.json'
let cachedRoutes = null

async function getProxyRoutes(env) {
  if (env && env.PROXY_ROUTES) {
    try { return JSON.parse(env.PROXY_ROUTES).proxy || {} } catch (e) { /* 用文件兜底 */ }
  }
  if (cachedRoutes) return cachedRoutes
  try {
    const res = await fetch(ROUTE_FILE)
    if (res.ok) {
      const data = await res.json()
      cachedRoutes = data.proxy || {}
      return cachedRoutes
    }
  } catch (e) {
    console.error('[ROUTES] 读取失败', e.message)
  }
  return cachedRoutes || {}
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false, mode: 'none' },
  'raw': { proxy: false, base58: false, mode: 'none' },
  '1': { proxy: true, base58: false, mode: 'all' },
  'proxy': { proxy: true, base58: false, mode: 'all' },
  '2': { proxy: false, base58: true, mode: 'none' },
  'base58': { proxy: false, base58: true, mode: 'none' },
  '3': { proxy: true, base58: true, mode: 'all' },
  'proxy-base58': { proxy: true, base58: true, mode: 'all' },
  // 混合模式：只给「实测直连慢/不通」的源加中转，其余保持直连
  '4': { proxy: true, base58: false, mode: 'mixed' },
  'mixed': { proxy: true, base58: false, mode: 'mixed' },
  '5': { proxy: true, base58: true, mode: 'mixed' },
  'mixed-base58': { proxy: true, base58: true, mode: 'mixed' }
}

// Base58 编码函数
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

// JSON api 字段前缀替换
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// ---------- 安全版：KV 缓存 ----------
async function getCachedJSON(url) {
  const kvAvailable = typeof KV !== 'undefined' && KV && typeof KV.get === 'function'

  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url
    const cached = await KV.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch (e) {
        await KV.delete(cacheKey)
      }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })   // 缓存 30 分钟
    return data
  } else {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    return await res.json()
  }
}

// ---------- 安全版：错误日志 ----------
async function logError(type, info) {
  // 保留错误输出，便于调试
  console.error('[ERROR]', type, info)

  // 禁止写入 KV
  return
}

// ---------- 主逻辑 ----------
async function handleRequest(request, env) {
  // 快速处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  // 🩺 健康检查（最常见的性能检查，提前处理）
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 通用代理请求处理
  if (targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // JSON 格式输出处理
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  // 返回首页文档
  return handleHomePage(currentOrigin, defaultPrefix)
}

// ---------- 代理请求处理子模块 ----------
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  // 🚨 防止递归调用自身
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }

  // 🚨 防止无效 URL
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', { url: targetUrlParam }, 400)
  }

  let fullTargetUrl = targetUrlParam
  const urlMatch = request.url.match(/[?&]url=([^&]+(?:&.*)?)/)
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)
  } catch {
    await logError('proxy', { message: 'Invalid URL', url: fullTargetUrl })
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400)
  }

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    await logError('proxy', { message: err.message || '代理请求失败', url: fullTargetUrl })
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: fullTargetUrl,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

// ---------- JSON 格式输出处理子模块 ----------
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(selectedSource)
    const prefix = prefixParam || defaultPrefix

    let newData
    let proxiedCount = 0
    if (!config.proxy) {
      newData = data
    } else if (config.mode === 'mixed') {
      // 只给白名单里的源加中转，其余保持直连
      const routes = await getProxyRoutes(env)
      newData = applyMixedProxy(data, prefix, routes)
      proxiedCount = countProxied(newData)
    } else {
      newData = addOrReplacePrefix(data, prefix)
      proxiedCount = countProxied(newData)
    }

    const headers = {
      ...CORS_HEADERS,
      'X-Proxy-Mode': config.mode || 'none',
      'X-Proxy-Routed': String(proxiedCount),
    }

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
      })
    } else {
      return new Response(JSON.stringify(newData), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers },
      })
    }
  } catch (err) {
    await logError('json', { message: err.message })
    return errorResponse(err.message, {}, 500)
  }
}

// 统计有多少条 api 已经带上中转前缀
function countProxied(obj) {
  let n = 0
  if (!obj || typeof obj !== 'object') return 0
  if (Array.isArray(obj)) return obj.reduce((s, v) => s + countProxied(v), 0)
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      if (obj[key].includes('?url=')) n++
    } else {
      n += countProxied(obj[key])
    }
  }
  return n
}

// 判断某个源是否在白名单里（按域名比对，避免 zy.com 这类子串误伤）
function shouldProxyUrl(rawUrl, routes) {
  let host
  try {
    host = new URL(rawUrl).host.toLowerCase()
  } catch {
    return false
  }
  for (const key in routes) {
    const k = key.toLowerCase()
    if (host === k || host.endsWith('.' + k) || k.endsWith('.' + host)) return true
  }
  return false
}

// 按白名单逐个加前缀：命中 proxy-routes.json 的才走中转，其余保持直连
function applyMixedProxy(obj, newPrefix, routes) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => applyMixedProxy(item, newPrefix, routes))

  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      // 先去掉已有的中转外壳，拿到裸地址再判断
      let rawUrl = obj[key]
      const urlIndex = rawUrl.indexOf('?url=')
      if (urlIndex !== -1) rawUrl = rawUrl.slice(urlIndex + 5)

      newObj[key] = shouldProxyUrl(rawUrl, routes) ? newPrefix + rawUrl : rawUrl
    } else {
      newObj[key] = applyMixedProxy(obj[key], newPrefix, routes)
    }
  }
  return newObj
}

// ---------- 首页文档处理 ----------
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .example { background: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 20px 0; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>通用 API 中转代理，用于访问被墙或限制的接口。</p>
  
  <h2>使用方法</h2>
  <p>中转任意 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}<示例API地址></pre>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀（全部走中转）<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码（全部走中转）<br>
            <code>4</code> 或 <code>mixed</code> = 混合：只给名单内慢/不通的源走中转<br>
            <code>5</code> 或 <code>mixed-base58</code> = 混合 Base58（推荐订阅）</td>
      </tr>
      <tr>
        <td>mode</td>
        <td><code>all</code> = format=1/3 全部走中转<br>
            <code>mixed</code> = format=4/5 只给实测慢/不通的源走中转，其余直连</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
    
  <div class="section">
    <h3>📦 精简版（jin18）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>🆕 混合 JSON（推荐，只把慢/不通的源走中转）：<br><code class="copyable">${currentOrigin}?format=4&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>🆕 混合 Base58（订阅用）：<br><code class="copyable">${currentOrigin}?format=5&source=jin18</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 精简版+成人（jingjian）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>🆕 混合 JSON（推荐，只把慢/不通的源走中转）：<br><code class="copyable">${currentOrigin}?format=4&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>🆕 混合 Base58（订阅用）：<br><code class="copyable">${currentOrigin}?format=5&source=jingjian</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，默认）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
    <p>🆕 混合 JSON（推荐，只把慢/不通的源走中转）：<br><code class="copyable">${currentOrigin}?format=4&source=full</code> <button class="copy-btn">复制</button></p>
    <p>🆕 混合 Base58（订阅用）：<br><code class="copyable">${currentOrigin}?format=5&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <h2>支持的功能</h2>
  <ul>
    <li>✅ 支持 GET、POST、PUT、DELETE 等所有 HTTP 方法</li>
    <li>✅ 自动转发请求头和请求体</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ 超时保护（9 秒）</li>
    <li>✅ 支持多种配置源切换</li>
    <li>✅ 支持 Base58 编码输出</li>
    <li>✅ 支持混合中转（format=4/5，只中转慢源，其余直连）</li>
  </ul>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, { 
    status: 200, 
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } 
  })
}

// ---------- 统一错误响应处理 ----------
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
