// HealthWidgetApp.swift
// 宿主 App：WidgetKit 在 macOS 上必须以一个 App 为容器。
// 本体只用于让组件出现在小组件库；运行一次即可，无需常驻。
import SwiftUI

@main
struct HealthWidgetApp: App {
    var body: some Scene {
        Window("健康小组件", id: "main") {
            ContentView()
        }
        .windowResizability(.contentSize)
    }
}
