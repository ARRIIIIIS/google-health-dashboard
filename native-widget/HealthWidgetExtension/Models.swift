// Models.swift
// 解析 ~/Library/Application Support/com.arrhealth.healthdashboard/data.json
// 字段与现有 Tauri 组件（App.jsx）读取的 today / history 对齐。
import Foundation

struct HealthData: Codable {
    let today: Today
    let history: [HistoryEntry]
}

struct Today: Codable {
    let steps: Int?
    let active_minutes: Int?
    let resting_hr: Int?
    let heart_rate: Int?
    let hrv: Int?
    let spo2: Int?
    let respiratory_rate: Int?
    let distance: Double?
    let calories: Int?
    let sleep_asleep_min: Int?
    let sleep_deep_min: Int?
    let sleep_rem_min: Int?
    let sleep_light_min: Int?
    let sleep_awake_min: Int?
    let idle_min: Int?
    let sedentary: Bool?
    let updated_at: String?
}

struct HistoryEntry: Codable {
    let date: String?
    let time: String?
    let steps: Int?
    let active_minutes: Int?
    let sleep_asleep_min: Int?
    let resting_hr: Int?
    let hrv: Int?
    let spo2: Int?
}
