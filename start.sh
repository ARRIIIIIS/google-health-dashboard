#!/bin/bash
# 健康仪表盘 · 一键启动
# 用法: ./start.sh   (或把它放进开机自启)
cd "$(dirname "$0")"

echo "🚀 启动健康仪表盘..."

# 数据服务（供 Übersicht 桌面组件使用，浏览器版不依赖它）
node data-server.js > /tmp/ghd-data.log 2>&1 &
echo "  · 数据服务 → http://127.0.0.1:8910"

# 界面 + 引导设置（浏览器用这个）
node standalone-server.js > /tmp/ghd-ui.log 2>&1 &
echo "  · 界面服务 → http://localhost:8911"

sleep 2
echo ""
echo "✅ 启动完成！"
if [ ! -f config.json ]; then
  echo "📝 首次使用，请打开引导设置页完成授权："
  echo "   http://localhost:8911/setup"
else
  echo "📊 仪表盘：http://localhost:8911"
fi
