import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定的端口与严格 CSP；这里放开以便开发预览。
export default defineConfig({
  plugins: [react()],
  // 透明窗口下 Tauri 用自定义协议加载；dev 走 vite 默认端口
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  // `?raw` 导入（情绪球 JS 内联）由 Vite 原生支持，无需额外配置
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: false,
  },
});
