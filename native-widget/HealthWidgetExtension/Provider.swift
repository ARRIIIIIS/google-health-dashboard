// Provider.swift
// TimelineProvider：读取 data.json，按系统预算安排刷新。
// 注意：WidgetKit 刷新由系统统一调度（15–60 分钟），无法按需即时刷新。
import WidgetKit
import Foundation

struct HealthEntry: TimelineEntry {
    let date: Date
    let data: HealthData
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> HealthEntry {
        HealthEntry(date: Date(), data: .mock)
    }

    func getSnapshot(in context: Context, completion: @escaping (HealthEntry) -> Void) {
        completion(HealthEntry(date: Date(), data: loadData() ?? .mock))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HealthEntry>) -> Void) {
        let data = loadData() ?? .mock
        let entry = HealthEntry(date: Date(), data: data)
        // 请求约 20 分钟后由系统再次刷新（实际间隔由系统预算决定，可能更长）
        let next = Calendar.current.date(byAdding: .minute, value: 20, to: Date())!
        let timeline = Timeline(entries: [entry], policy: .after(next))
        completion(timeline)
    }

    // 直接读绝对路径（组件与 Tauri app 均未沙盒化，无需 App Group）。
    // 若日后开启沙盒，请改用 App Group 共享容器。
    func loadData() -> HealthData? {
        let base = FileManager.default.homeDirectoryForCurrentUser
        let url = base.appendingPathComponent(
            "Library/Application Support/com.arrhealth.healthdashboard/data.json"
        )
        guard let raw = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(HealthData.self, from: raw)
    }
}

extension HealthData {
    // 占位 / 预览用样例数据（取自真实 data.json 的典型值）
    static let mock = HealthData(
        today: Today(
            steps: 5445,
            active_minutes: 61,
            resting_hr: nil,
            heart_rate: 72,
            hrv: 48,
            spo2: 98,
            respiratory_rate: 14,
            distance: 4.3,
            calories: 1811,
            sleep_asleep_min: 467,
            sleep_deep_min: 80,
            sleep_rem_min: 106,
            sleep_light_min: 276,
            sleep_awake_min: 24,
            idle_min: 90,
            sedentary: true,
            updated_at: "16:49"
        ),
        history: []
    )
}
