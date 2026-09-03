// HealthWidgetView.swift
// 1:1 还原现有 Tauri 组件（App.jsx · Widget 渲染 + C_DARK 配色）。
// 不能复刻的活能力：情绪球实时画布（静态心情字形替代）、刷新按钮（装饰/无操作）、
// 久坐 chip 点开弹窗（仅静态显示「已静坐 X 分钟」）、AI tip 实时生成（用本地兜底池）。
import SwiftUI
import WidgetKit

// ── 调色板（对应 App.jsx C_DARK）──
private struct C {
    static let label   = Color.white.opacity(0.95)
    static let second  = Color.white.opacity(0.86)
    static let third   = Color.white.opacity(0.66)
    static let card    = Color.white.opacity(0.10)
    static let hairline = Color.white.opacity(0.12)
    static let red     = Color(hex: 0xFF375F)
    static let green   = Color(hex: 0x30D158)
    static let blue    = Color(hex: 0x0A84FF)
    static let teal    = Color(hex: 0x40C8E0)
    static let indigo  = Color(hex: 0x5E5CE6)
    static let amber   = Color(hex: 0xFF9F0A)
}

private extension Color {
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

struct HealthWidgetView: View {
    var entry: HealthEntry
    private var t: Today { entry.data.today }

    var body: some View {
        VStack(spacing: 8) {
            header
            stepsBlock
            stepBar
            metricsRow
            sleepRow
            tipRow
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .containerBackground(for: .widget) {
            Color.black.opacity(0.30)
        }
    }

    // ── 顶栏 ──
    @ViewBuilder private var header: some View {
        HStack(alignment: .center, spacing: 9) {
            logoRings
            Text("健康")
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(C.label)
            Spacer()
            emotionBall
            idleChip
            Text(t.updated_at ?? "--:--")
                .font(.system(size: 9))
                .foregroundColor(C.third)
            // 装饰性刷新图标：WidgetKit 无用户触发刷新，故无操作
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 11))
                .foregroundColor(C.second)
                .opacity(0.55)
        }
        .padding(.horizontal, 2)
    }

    private var logoRings: some View {
        ZStack {
            Circle().trim(from: 0.12, to: 1.0).stroke(C.red, lineWidth: 1.7)
                .frame(width: 14.6, height: 14.6).rotationEffect(.degrees(-90))
            Circle().trim(from: 0.16, to: 1.0).stroke(C.green, lineWidth: 1.7)
                .frame(width: 10.0, height: 10.0).rotationEffect(.degrees(-90))
            Circle().trim(from: 0.20, to: 1.0).stroke(C.blue, lineWidth: 1.7)
                .frame(width: 5.6, height: 5.6).rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
    }

    // 情绪球：原生无 WebView/iframe，用静态心情字形替代
    private var emotionBall: some View {
        Circle()
            .fill(AngularGradient(colors: [C.amber, C.green, C.blue, C.amber],
                                 center: .center))
            .frame(width: 44, height: 44)
            .opacity(0.72)
            .overlay(Circle().stroke(Color.white.opacity(0.10)))
    }

    @ViewBuilder private var idleChip: some View {
        let mins = t.idle_min ?? 0
        let sed = t.sedentary ?? false
        HStack(spacing: 4) {
            Image(systemName: "hourglass")
            Text("\(mins) min")
        }
        .font(.system(size: 9, weight: .semibold))
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(sed ? C.amber.opacity(0.16) : C.card)
        .foregroundColor(sed ? C.amber : C.third)
        .clipShape(Capsule())
    }

    // ── 步数主区 ──
    @ViewBuilder private var stepsBlock: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 4) {
                Text(stepsText)
                    .font(.system(size: 46, weight: .bold))
                    .tracking(-2)
                    .foregroundColor(C.label)
                Text(midLine)
                    .font(.system(size: 11.5))
                    .foregroundColor(C.second)
            }
            Spacer()
            VStack(alignment: .trailing) {
                (
                    Text(activeText)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(C.green)
                    + Text(" 分钟活跃")
                        .font(.system(size: 9))
                        .foregroundColor(C.third)
                )
            }
        }
        .padding(.horizontal, 4)
    }

    private var stepsText: String {
        (t.steps?.formatted()) ?? "—"
    }
    private var activeText: String {
        (t.active_minutes.map { "\($0)" }) ?? "—"
    }
    private var midLine: String {
        let d = t.distance.map { String(format: "%.1fkm", $0) } ?? "—"
        let c = t.calories.map { "\($0) 千卡" } ?? ""
        return "步 · 距离 \(d)\(c.isEmpty ? "" : " · \(c)")"
    }

    // ── 步数进度条 ──
    private var stepBar: some View {
        let goal = 8000
        let pct = min(100, Int(round(Double(t.steps ?? 0) / Double(goal) * 100)))
        return GeometryReader { geo in
            Capsule().fill(C.card)
            Capsule()
                .fill(LinearGradient(colors: [Color(hex: 0x8BF2A8), C.green],
                                     startPoint: .leading, endPoint: .trailing))
                .frame(width: geo.size.width * CGFloat(pct) / 100)
        }
        .frame(height: 3)
    }

    // ── 四宫格指标 ──
    @ViewBuilder private var metricsRow: some View {
        HStack(spacing: 0) {
            metric(label: "心率", value: intText(t.resting_hr ?? t.heart_rate),
                   unit: "bpm", color: C.red)
            Divider().background(C.hairline)
            metric(label: "HRV", value: intText(t.hrv),
                   unit: "ms", color: C.blue)
            Divider().background(C.hairline)
            metric(label: "血氧", value: intText(t.spo2),
                   unit: "%", color: C.teal)
            Divider().background(C.hairline)
            metric(label: "呼吸", value: intText(t.respiratory_rate),
                   unit: "／min", color: C.indigo)
        }
        .padding(.vertical, 7)
        .overlay(Divider().background(C.hairline), alignment: .top)
        .overlay(Divider().background(C.hairline), alignment: .bottom)
    }

    @ViewBuilder private func metric(label: String, value: String,
                                     unit: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.system(size: 8)).foregroundColor(C.third)
            Text(value).font(.system(size: 15, weight: .semibold)).foregroundColor(color)
            Text(unit).font(.system(size: 7.5)).foregroundColor(C.third)
        }
        .frame(maxWidth: .infinity)
    }

    private func intText(_ v: Int?) -> String {
        v.map { "\($0)" } ?? "—"
    }

    // ── 睡眠 ──
    @ViewBuilder private var sleepRow: some View {
        let total = t.sleep_asleep_min ?? 0
        let awake = t.sleep_awake_min ?? 0
        let rem = t.sleep_rem_min ?? 0
        let light = t.sleep_light_min ?? 0
        let deep = t.sleep_deep_min ?? 0
        HStack(spacing: 8) {
            Text("睡眠").font(.system(size: 9)).foregroundColor(C.third)
            Text(fmtSleep(total))
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(C.label)
            GeometryReader { geo in
                let sum = max(1, CGFloat(awake + rem + light + deep))
                HStack(spacing: 0) {
                    segF(frac: CGFloat(awake) / sum, color: Color(white: 0.6).opacity(0.55))
                    segF(frac: CGFloat(rem) / sum, color: C.amber)
                    segF(frac: CGFloat(light) / sum, color: C.teal)
                    segF(frac: CGFloat(deep) / sum, color: C.indigo)
                }
                .frame(width: geo.size.width, height: 4)
                .clipShape(RoundedRectangle(cornerRadius: 2))
            }
            .frame(height: 4)
            if deep > 0 {
                Text("深\(deep)·REM\(rem)")
                    .font(.system(size: 8.5))
                    .foregroundColor(C.third)
            }
        }
        .padding(.horizontal, 2)
    }

    @ViewBuilder private func segF(frac: CGFloat, color: Color) -> some View {
        if frac > 0 {
            Rectangle().fill(color)
                .frame(maxWidth: .infinity)
                .layoutPriority(frac)
        }
    }

    private func fmtSleep(_ m: Int) -> String {
        guard m > 0 else { return "—" }
        return "\(m / 60)h\(m % 60)m"
    }

    // ── AI tip（本地兜底池，按分钟轮换；原生无 LLM 调用）──
    @ViewBuilder private var tipRow: some View {
        HStack(spacing: 6, alignment: .top) {
            Circle().fill(C.blue).frame(width: 4, height: 4)
                .shadow(color: C.blue, radius: 3)
            Text(tipText)
                .font(.system(size: 9.5))
                .foregroundColor(C.second)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
    }

    private var tipText: String {
        let tips = [
            "喝杯水，活动一下筋骨吧。",
            "深呼吸，放松一下肩膀。",
            "休息一会，眼睛看向远方。",
            "保持节奏，劳逸结合。",
            "今天的目标很接近了，加油！",
            "保持好心情，状态会更好。",
            "适当补水，身体更轻松。",
            "午后容易困，动一动提提神。",
        ]
        let i = Calendar.current.component(.minute, from: Date()) % tips.count
        return tips[i]
    }
}
