// encode.js - 把 JSON 配置编码成 Base58 订阅串
// 用法: node encode.js     （package.json 里 npm run encode 就是跑这个）
const fs = require('fs');
const path = require('path');

// 兼容 bs58 v5 / v6：v6 的 require 出口可能带 default 包装
const bs58Module = require('bs58');
const bs58 = bs58Module && typeof bs58Module.encode === 'function'
  ? bs58Module
  : bs58Module.default;

const FILES = [
  { input: 'LunaTV-config.json', output: 'LunaTV-config.txt' },
  { input: 'jingjian.json', output: 'jingjian.txt' },
  { input: 'jin18.json', output: 'jin18.txt' }
];

let done = 0;
for (const file of FILES) {
  const inputPath = path.join(__dirname, file.input);
  if (!fs.existsSync(inputPath)) {
    console.warn(`⚠️  跳过（文件不存在）: ${file.input}`);
    continue;
  }

  // 统一成 LF 再编码：仓库里提交的 .txt 是按 LF 内容生成的，
  // 在 Windows（git autocrlf）上直接读工作区文件会带 \r，导致订阅串无谓变动
  const text = fs.readFileSync(inputPath, 'utf8').replace(/\r\n/g, '\n');
  // 先校验 JSON，避免编码出一份坏订阅
  JSON.parse(text);

  const encoded = bs58.encode(Buffer.from(text, 'utf8'));
  fs.writeFileSync(path.join(__dirname, file.output), encoded, 'utf8');
  console.log(`✅ ${file.input} → ${file.output}（${Buffer.byteLength(text)} 字节 → ${encoded.length} 字符）`);
  done++;
}

if (done === 0) {
  console.error('❌ 没找到任何可编码的 JSON 文件');
  process.exit(1);
}
