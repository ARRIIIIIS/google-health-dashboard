// HealthWidgetBundle.swift
import WidgetKit
import SwiftUI

@main
struct HealthWidgetBundle: WidgetBundle {
    var body: some Widget {
        HealthWidget()
    }
}

struct HealthWidget: Widget {
    let kind = "HealthWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            HealthWidgetView(entry: entry)
        }
        .configurationDisplayName("健康")
        .description("步数、活动、睡眠与久坐提醒（数据来自健康桌面组件）。")
        .supportedFamilies([.systemMedium])
    }
}
