//  update_readme.js
//  作用：把 report.md 的检测结果写回 README，并按实际 JSON 文件刷新「配置源数量」统计
const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, 'report.md');
const readmePath = path.join(__dirname, 'README.md');

// 需要同步「配置源对比」统计的文档
const STATS_DOCS = [
    path.join(__dirname, 'README.md'),
    path.join(__dirname, 'CORSAPI', 'README.md')
];

const STATS_START = '<!-- SOURCE_STATS_START -->';
const STATS_END = '<!-- SOURCE_STATS_END -->';

// === 1. 读取 report.md ===
// Windows 上工作区文件是 CRLF，脚本统一按 LF 处理，否则表格正则永远匹配不到
const readText = (filePath) => fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
const writeText = (filePath, content) => fs.writeFileSync(filePath, content, 'utf-8');

if (!fs.existsSync(reportPath)) {
    console.error('❌ report.md 不存在，请先运行 check_api.js');
    process.exit(1);
}

const reportContent = readText(reportPath);

// 提取 Markdown 表格
const tableMatch = reportContent.match(/\| 状态 \|[\s\S]+?\n\n/);
if (!tableMatch) {
    console.error('❌ report.md 中未找到表格');
    process.exit(1);
}
let tableMd = tableMatch[0].trim();

// 拆分表格行
const lines = tableMd.split('\n');
const header = lines.slice(0, 2); // 表头部分
const rows = lines.slice(2); // 数据部分

// 解析每一行数据，提取可用率
const rowsWithData = rows.map(line => {
    const cols = line.split('|').map(c => c.trim());
    const status = cols[1]; // 状态列
    const apiName = cols[2]; // API名称列
    const apiAddress = cols[4]; // API地址列
    const successCount = parseInt(cols[6]) || 0; // 成功次数
    const failCount = parseInt(cols[7]) || 0; // 失败次数
    const availabilityStr = cols[8]; // 可用率列

    // 提取可用率数字（去掉%符号）
    const availabilityMatch = availabilityStr.match(/(\d+\.?\d*)%/);
    const availability = availabilityMatch ? parseFloat(availabilityMatch[1]) : 0;

    return {
        line: line,
        cols: cols,
        status: status,
        apiName: apiName,
        apiAddress: apiAddress,
        successCount: successCount,
        failCount: failCount,
        availability: availability,
        isSuccess: status.includes('✅')
    };
});

// 按照可用率排序（从高到低），可用率相同时按API名称排序
rowsWithData.sort((a, b) => {
    if (Math.abs(b.availability - a.availability) > 0.01) { // 避免浮点数精度问题
        return b.availability - a.availability; // 按可用率降序
    }
    return a.apiName.localeCompare(b.apiName); // 可用率相同时按API名称升序
});

// 生成排序后的表格行
const sortedRows = rowsWithData.map(row => row.line);

// 更新表格
tableMd = [...header, ...sortedRows].join('\n');

// 统计数据
const totalApis = rowsWithData.length;
const successApis = rowsWithData.filter(row => row.isSuccess).length;
const failApis = totalApis - successApis;

// 按可用率区间分类
const perfectApis = rowsWithData.filter(row => row.availability === 100).length;
const highAvailability = rowsWithData.filter(row => row.availability >= 80 && row.availability < 100).length;
const mediumAvailability = rowsWithData.filter(row => row.availability >= 50 && row.availability < 80).length;
const lowAvailability = rowsWithData.filter(row => row.availability < 50).length;

// 计算平均可用率
const averageAvailability = totalApis > 0 ? (rowsWithData.reduce((sum, row) => sum + row.availability, 0) / totalApis).toFixed(1) : 0;

// 获取当前 CST 时间
const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16) + " CST";

// 生成带统计和时间戳的区块
const tableBlock =
    `## API 状态（最近更新：${now}）\n\n` +
    `- 总 API 数量：${totalApis}\n` +
    `- 成功 API 数量：${successApis}\n` +
    `- 失败 API 数量：${failApis}\n` +
    `- 平均可用率：${averageAvailability}%\n` +
    `- 完美可用率（100%）：${perfectApis} 个\n` +
    `- 高可用率（80%-99%）：${highAvailability} 个\n` +
    `- 中等可用率（50%-79%）：${mediumAvailability} 个\n` +
    `- 低可用率（<50%）：${lowAvailability} 个\n\n` +
    `<div style="font-size: 11px;">\n\n` +
    `<!-- API_TABLE_START -->\n${tableMd}\n<!-- API_TABLE_END -->`;

// 读取 README.md（可能不存在）
let readmeContent = fs.existsSync(readmePath) ? readText(readmePath) : "";

// 替换或追加
if (readmeContent.includes("<!-- API_TABLE_START -->") && readmeContent.includes("<!-- API_TABLE_END -->")) {
    readmeContent = readmeContent.replace(
        /## API 状态（最近更新：[^\n]+）[\s\S]*?<!-- API_TABLE_END -->/,
        tableBlock
    );
    console.log("✅ README.md 已更新 API 状态表格（按可用率排序）");
} else {
    readmeContent += `\n\n${tableBlock}\n`;
    console.log("⚠️ README.md 未找到标记，已自动追加 API 状态表格到末尾");
}

// 写回文件
writeText(readmePath, readmeContent);

// === 2. 按实际 JSON 文件刷新「配置源对比」统计 ===
function loadSourceStats() {
    const spec = [
        { file: 'jin18.json', label: 'jin18', usage: '家庭使用、轻量级应用' },
        { file: 'jingjian.json', label: 'jingjian', usage: '个人使用、中等需求' },
        { file: 'LunaTV-config.json', label: 'full', usage: '完整功能、最大兼容性' }
    ];

    return spec.map(({ file, label, usage }) => {
        const fullPath = path.join(__dirname, file);
        if (!fs.existsSync(fullPath)) {
            return { label, count: 0, adult: false, usage, missing: true };
        }
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const sites = Object.values(data.api_site || {});
        const adult = sites.some(s => String(s.name || '').startsWith('🔞'));
        return { label, count: sites.length, adult, usage, missing: false };
    });
}

function buildStatsBlock(stats) {
    const rows = stats.map(s => {
        const adultMark = s.adult ? '✅ 是' : '❌ 否';
        return `| **${s.label}** | ${s.count}个 | ${adultMark} | ${s.usage} |`;
    }).join('\n');

    return [
        STATS_START,
        '| 配置源 | 资源数量 | 包含成人内容 | 适用场景 |',
        '| --- | --- | --- | --- |',
        rows,
        '',
        `> 资源数量由 update_readme.js 按仓库内 JSON 自动生成（最近更新：${now}）。`,
        STATS_END
    ].join('\n');
}

const statsBlock = buildStatsBlock(loadSourceStats());

for (const docPath of STATS_DOCS) {
    if (!fs.existsSync(docPath)) continue;
    let content = readText(docPath);

    if (content.includes(STATS_START) && content.includes(STATS_END)) {
        // 用 split 避免正则里 ${} 之类的意外转义问题
        const before = content.slice(0, content.indexOf(STATS_START));
        const after = content.slice(content.indexOf(STATS_END) + STATS_END.length);
        content = before + statsBlock + after;
        writeText(docPath, content);
        console.log(`✅ ${path.relative(__dirname, docPath)} 已刷新配置源数量统计`);
    } else {
        console.log(`⚠️ ${path.relative(__dirname, docPath)} 缺少 ${STATS_START} 标记，跳过数量统计`);
    }
}

// 输出排序结果摘要
console.log(`\n📊 统计摘要：`);
console.log(`- 平均可用率：${averageAvailability}%`);
console.log(`- 完美可用率 API：${perfectApis} 个`);
console.log(`- 高可用率 API：${highAvailability} 个`);
console.log(`- 中等可用率 API：${mediumAvailability} 个`);
console.log(`- 低可用率 API：${lowAvailability} 个`);

// 显示排序后的前10个和后5个API
console.log(`\n🏆 可用率最高的前10个API：`);
rowsWithData.slice(0, 10).forEach((row, index) => {
    console.log(`${index + 1}. ${row.apiName}: ${row.availability}%`);
});

console.log(`\n⚠️ 可用率最低的后5个API：`);
rowsWithData.slice(-5).forEach((row, index) => {
    console.log(`${rowsWithData.length - 4 + index}. ${row.apiName}: ${row.availability}%`);
});
