// ContentView.swift
import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "heart.fill")
                .font(.system(size: 40))
                .foregroundColor(.red)
            Text("健康小组件")
                .font(.title2.bold())
            Text("组件已随本 App 安装。\n在 macOS 小组件库（点击桌面或菜单栏小组件按钮）中添加「健康」即可。")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(width: 260)
        }
        .padding(28)
        .frame(width: 320, height: 220)
    }
}
