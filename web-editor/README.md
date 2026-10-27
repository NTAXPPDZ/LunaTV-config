# 🌙 Luna TV 配置编辑器

一个专业的JSON配置文件编辑器，专为Luna TV配置管理而设计。


## ✨ 主要功能

### 🎯 核心功能
- **JSON编辑**: 基于Monaco Editor的专业代码编辑体验
- **实时验证**: 实时JSON格式验证，中文错误提示
- **语法高亮**: 完整的JSON语法高亮和代码折叠
- **格式化**: 一键格式化和压缩JSON

### 🔄 GitHub集成
- **同步加载**: 直接从GitHub仓库加载配置文件
- **安全保存**: 通过GitHub API安全保存到仓库
- **Token管理**: 安全的Token存储和管理
- **版本控制**: 自动生成提交信息和版本历史

### 👁️ 可视化功能
- **树状视图**: JSON数据的可折叠树状展示
- **预览模式**: 格式化后的JSON预览
- **多主题**: 深色、浅色、高对比度主题
- **全屏模式**: 专注的全屏编辑体验

### 📁 文件操作
- **文件上传**: 支持本地JSON文件上传
- **文件下载**: 导出编辑后的配置文件
- **历史记录**: 本地历史版本管理
- **自动保存**: 防止数据丢失的自动保存

### ⌨️ 快捷键支持
- `Ctrl + S`: 保存到GitHub
- `Ctrl + O`: 从GitHub加载
- `Ctrl + U`: 上传文件
- `Ctrl + D`: 下载文件
- `F11`: 全屏模式
- `Ctrl + F`: 查找
- `Ctrl + H`: 查找替换

## 🚀 使用方法

### 1. 获取GitHub Token
1. 访问 [GitHub Settings → Personal access tokens](https://github.com/settings/tokens)
2. 点击 "Generate new token (classic)"
3. 选择 `repo` 权限
4. 复制生成的Token

### 2. 开始使用
1. 在编辑器中输入您的GitHub Token
2. 点击"📥 加载配置"按钮
3. 在编辑器中修改配置
4. 点击"💾 保存配置"或使用 `Ctrl+S`

### 3. 换成你自己的仓库
编辑 `script.js` 顶部的 `GITHUB_CONFIG`（`owner` / `repo` / `branch`），
或者直接在地址后面加参数临时指定：

```
?owner=你的用户名&repo=仓库名&branch=main
```

不改成自己的仓库，保存时会去改别人的仓库并返回 403。

## 🛠️ 技术特性

- **现代化UI**: 基于CSS Grid和Flexbox的响应式设计
- **Monaco 编辑器**: 通过 jsDelivr CDN 加载，无构建步骤
- **容错处理**: 键盘事件兼容补丁 + CDN 加载失败提示
- **模块化架构**: 清晰的代码组织和功能分离
- **国际化**: 完整的中文界面和错误提示

## 🔒 安全特性

- **Token 不落盘**: Token 只存在于当前页面内存和输入框，本编辑器不写 localStorage / 不加密存储
- **浏览器接管**: 依赖浏览器自带的密码管理器填充，是否保存由你决定
- **手动清除**: 点「🗑️ 清除Token」立即从内存和输入框移除
- **权限最小化**: 只需要 `repo`（或更细的 contents 写权限）即可保存

> 注意：页面刷新后 Token 会丢失（除非浏览器自动填充）。

## 📱 浏览器兼容性

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## 🤝 贡献

欢迎提交Issue和Pull Request来改进这个项目！

## 📄 许可证

MIT License
