---
paths:
  - "src/**/*.tsx"
  - "src/**/*.ts"
  - "src/**/*.css"
---

# 前端规范

## 组件

- **单一职责**：一个组件只做一件事。超过 300 行考虑拆分子组件。
- **App.tsx 保持精简**：只做 UI 编排和根级状态，不持有业务领域状态。
- **共享状态走 Context**：跨组件共享的状态放 Context，拒绝 props drilling。
- **业务逻辑封装在 Hook**：领域逻辑（CRUD、事件订阅）放自定义 Hook，不写在组件里。
- **错误边界**：独立功能面板用 ErrorBoundary 包裹，防止一个崩溃波及全局。
- **正确清理**：`useEffect` 中的事件监听/订阅必须返回 cleanup 函数。

## 样式

- **CSS Modules**（`*.module.css`）实现组件级样式隔离。
- **CSS 变量**：所有颜色、间距、字体引用 `var(--xxx)`，禁止硬编码。
- **主题变量集中管理**：暗/亮主题的自定义属性放在独立 CSS 文件中，通过 `[data-theme]` 切换。
- **全局样式尽量少**：只放 reset、动画、共享组件（按钮/弹窗）的最小样式。

## API 层

- **单一入口**：所有后端调用（invoke/listen）放在一个模块中，组件不直接 import 平台 API。
- **事件监听工厂返回 unsubscribe**：统一 `Promise<() => void>` 模式，便于 useEffect 清理。

## 类型

- **共享类型放在独立文件**：不放在 App.tsx 或组件文件中。
- **前后端类型分离**：后端序列化类型和前端展示类型分开定义，在 API 层做映射。

## 命名

- TypeScript / JavaScript：`camelCase`
- Rust 后端字段保持 `snake_case`（在 API 层转换）
- CSS Module 选择器：`camelCase`
