# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.26] - 2026-01-08

### Fixed
- **Critical**: 修复对话框窗口关闭导致同步终止的问题
  - 根本原因：窗口 `unload` 事件与按钮点击事件存在竞争条件
  - 影响：首次同步策略对话框和冲突解决对话框，点击按钮后窗口消失但同步被错误终止
  - 修复：添加 `isResolved` 标志和延迟 resolve 机制，确保用户选择被正确捕获

### Improved
- 改进了对话框关闭处理逻辑，提升用户体验
- 统一了对话框关闭处理的实现方式

## [0.1.25] - 2026-01-07

### Added
- ⚡ **性能提升**：实现并发上传下载，显著提升同步速度（3倍速度提升）
  - 默认并发数：3 个文件同时上传/下载
  - 可通过设置自定义并发数
- ✨ 添加了首次同步策略选择对话框
  - 上传到云端（覆盖云端文件）
  - 从云端下载（覆盖本地文件）
  - 合并（保留双方文件）

### Changed
- 重构了文件上传下载逻辑，使用批处理方式提升性能
- 改进了同步进度显示，实时更新当前处理的文件

## [0.1.24] - 2026-01-06

### Fixed
- 过滤元数据文件，避免被当作附件处理

## [0.1.23] - 2026-01-06

### Changed
- 代码重构和优化

## [0.1.21] - 2026-01-07

### Fixed
- **Critical**: 修复了文件重复下载问题
  - 根本原因：`determineOperation` 方法缺少 `async` 关键字，导致 `await` 被忽略
  - 影响：所有文件在每次同步时都会被错误地标记为需要下载
  - 修复：添加 `async` 关键字并更新返回类型为 `Promise<SyncOperation>`

### Improved
- 增强了 no-change 文件的元数据记录
- 添加了详细的调试日志便于问题诊断

## [0.1.17-0.1.20] - 2026-01-06

⚠️ 这些版本存在严重的重复下载 bug，请升级到 v0.1.21 或更高版本

## [0.1.0-0.1.16] - Early Versions

### Added
- ✨ 实现 S3 客户端和同步管理器
- ✨ 支持双向同步（上传和下载）
- ✨ 智能三路合并算法
- ✨ 冲突检测和解决
- ✨ 连接测试功能
- ✨ 增量同步支持
- ✨ 多语言支持（中文/英文）

### Features
- 支持任何 S3 兼容的对象存储（AWS S3, MinIO, 阿里云 OSS, 腾讯云 COS 等）
- 可配置的文件路径前缀
- MD5 哈希校验确保数据完整性
- 实时同步进度显示
- 详细的调试日志输出
