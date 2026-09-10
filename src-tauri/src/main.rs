// ─────────────────────────────────────────────────────────────────────────────
// main.rs —— Tauri 后端
//  · 启动后常驻线程，按 settings.refresh_interval_min 调用 Python 采集脚本写 data.json
//  · 命令：read_data / refresh_now / reset_sedentary / get_settings / save_settings
//          list_displays / set_position / set_autostart / is_dnd_active / get_appearance
//  · 数据层（Google Health API）完全复用原 Python 脚本，未重写
//  · 设置持久化到 ~/Library/Application Support/com.arrhealth.healthdashboard/settings.json
// ─────────────────────────────────────────────────────────────────────────────
use std::ffi::CStr;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Once;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use std::net::{TcpListener, TcpStream};
use std::io::{BufRead, BufReader, Read, Write};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, AppHandle};

#[cfg(target_os = "macos")]
use objc::runtime::{BOOL, Class, Object, Sel};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
#[cfg(target_os = "macos")]
use objc::{Encode, Encoding};
#[cfg(target_os = "macos")]
// liquid_glass 插件已弃用：NSGlassEffectView 边缘折射光晕在桌面小组件上不可控，
// 改用 window_vibrancy（NSVisualEffectView HudWindow 材质），边缘干净。

// ── 设置 ─────────────────────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    language: String,
    theme: String, // auto | light | dark
    refresh_interval_min: u64,
    autostart: bool,
    display_ids: Vec<i32>, // NSScreen hashValue 列表
    display: i32,    // 兼容：上次选中的 primary display id
    pos_x: i32,
    pos_y: i32,
    /// 用户是否手动摆放过小组件。false = 从未摆放（启动时居中），true = 恢复上次位置
    pos_saved: bool,
    /// 桌面伙伴角色：qiuqiu(球球) / nimbo(云宝) / twinkle(亮亮) / claw(钳钳) / random(每 3 分钟轮换)
    /// 系统勿扰（Focus）始终跟随，不再提供「勿扰式静音」用户开关。
    #[serde(default = "default_character")]
    character: String,
    /// 视觉主题（仅换皮肤，布局不变）：liquid-glass(液态玻璃/系统磨砂) / pixel-anime(像素动漫风)
    #[serde(default = "default_style")]
    style: String,
    widget_visible: bool, // 小组件主窗口是否显示
    sedentary_min: u64, // 连续不动超过此时长(分钟)判定久坐
    sedentary_remind_min: u64, // 久坐后每隔多久复查提醒一次(分钟)
    google_client_id: String,
    google_client_secret: String,
    llm_base_url: String,
    llm_api_key: String,
    llm_model: String,
    #[serde(default = "default_gaze_threshold")]
    gaze_threshold: f64,
    #[serde(default = "default_gaze_radius")]
    gaze_radius: f64,
    /// 自定义 app 名称（空 = 用 i18n 默认标题）
    #[serde(default)]
    app_name: String,
    /// 自定义图标："" = 默认；"preset:<id>" = 内置预设；"base64:<data>" = 用户上传（PNG）
    #[serde(default)]
    custom_icon: String,
    /// 是否跟随系统勿扰（Focus）抑制久坐提醒。true = 系统勿扰时静默；false = 始终提醒。
    #[serde(default = "default_true")]
    dnd_follow: bool,
}

fn default_true() -> bool { true }

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: "zh-CN".into(),
            theme: "auto".into(),
            refresh_interval_min: 5,
            autostart: false,
            display_ids: vec![],
            display: -1,
            pos_x: 20,
            pos_y: 60,
            pos_saved: false,
            character: "qiuqiu".into(),
            style: "liquid-glass".into(),
            widget_visible: true,
            sedentary_min: 45,
            sedentary_remind_min: 30,
            google_client_id: String::new(),
            google_client_secret: String::new(),
            llm_base_url: String::new(),
            llm_api_key: String::new(),
            llm_model: String::new(),
            // gaze 跟随更灵敏：阈值 1.0（满偏）+ 满偏距离 80px（更小=鼠标更近就到满偏）
            gaze_threshold: 1.0,
            gaze_radius: 80.0,
            app_name: String::new(),
            custom_icon: String::new(),
            dnd_follow: true,
        }
    }
}

fn default_gaze_threshold() -> f64 { 1.0 }
fn default_gaze_radius() -> f64 { 80.0 }
fn default_character() -> String { "qiuqiu".into() }
fn default_style() -> String { "liquid-glass".into() }

const SETTINGS_FILE: &str = "settings.json";

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir")
        .join(SETTINGS_FILE)
}

fn load_settings(app: &AppHandle) -> Settings {
    let p = settings_path(app);
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Settings>(&s) {
            return v;
        }
    }
    Settings::default()
}

fn save_settings_file(app: &AppHandle, s: &Settings) -> std::io::Result<()> {
    let dir = app.path().app_data_dir().expect("app_data_dir");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(SETTINGS_FILE), serde_json::to_string_pretty(s)?)
}

/// 用户上传的自定义图标文件路径（app_data_dir/custom_icon.png）
fn custom_icon_file(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("app_data_dir");
    dir.join("custom_icon.png")
}

/// 内置预设图标（base64 PNG，256x256）。避免额外资源文件，纯代码内置几个风格色块。
/// 预设 id → base64 PNG。
fn preset_icon_bytes(id: &str) -> Option<Vec<u8>> {
    // 用 image crate 现画一个 256x256 的圆角色块图标（比手工 base64 更省事、可扩展）
    let (r, g, b) = match id {
        "teal"    => (48, 209, 88),   // 绿
        "blue"    => (10, 132, 255),  // 蓝
        "orange"  => (255, 159, 10),  // 橙
        "purple"  => (175, 82, 222),  // 紫
        "red"     => (255, 69, 58),   // 红
        _ => return None,
    };
    // 256x256 纯色 + 内圆环（模拟健康环）
    use image::{ImageBuffer, Rgba, RgbaImage};
    let mut img: RgbaImage = ImageBuffer::from_pixel(256, 256, Rgba([r, g, b, 255]));
    // 画白色内圆（环心）
    let cx = 128.0_f32; let cy = 128.0_f32;
    for y in 0..256 {
        for x in 0..256 {
            let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            if d > 52.0 && d < 78.0 {
                img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    if image::DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, image::ImageFormat::Png)
        .is_ok()
    {
        Some(buf.into_inner())
    } else {
        None
    }
}

/// 把设置里的 custom_icon 解析成 tauri Image（供 tray 使用）。
/// 返回 None = 用默认图标。
fn resolve_icon_image(app: &AppHandle, s: &Settings) -> Option<tauri::image::Image<'static>> {
    use tauri::image::Image;
    let c = s.custom_icon.as_str();
    if c.is_empty() {
        return None; // 默认图标由调用方从 resources/icons 加载
    }
    if let Some(rest) = c.strip_prefix("preset:") {
        if let Some(bytes) = preset_icon_bytes(rest) {
            return Image::from_bytes(&bytes).ok();
        }
        return None;
    }
    if let Some(rest) = c.strip_prefix("base64:") {
        // 用户上传：先落盘（供前端 <img> 显示 & 重启后复用），再加载
        if let Ok(bytes) = base64_decode(rest) {
            if let Ok(dir) = app.path().app_data_dir() {
                std::fs::create_dir_all(&dir).ok();
                let _ = std::fs::write(dir.join("custom_icon.png"), &bytes);
            }
            return Image::from_bytes(&bytes).ok();
        }
        return None;
    }
    None
}

/// 简易 base64 解码（std 无内置，手写最小实现）
fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    let mut table = [-1i8; 256];
    for (i, &ch) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".iter().enumerate() {
        table[ch as usize] = i as i8;
    }
    let clean: Vec<u8> = s.bytes().filter(|b| *b != b'\n' && *b != b'\r' && *b != b' ').collect();
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    let mut i = 0;
    while i + 4 <= clean.len() {
        let a = table[clean[i] as usize];
        let b2 = table[clean[i + 1] as usize];
        let c = table[clean[i + 2] as usize];
        let d = table[clean[i + 3] as usize];
        if a < 0 || b2 < 0 { return Err(()); }
        let x = ((a as u32) << 18) | ((b2 as u32) << 12);
        out.push((x >> 16) as u8);
        if clean[i + 2] != b'=' && c >= 0 {
            out.push(((x >> 8) & 0xff) as u8);
            if clean[i + 3] != b'=' && d >= 0 {
                out.push((x & 0xff) as u8);
            }
        }
        i += 4;
    }
    Ok(out)
}

/// 把当前设置的自定义图标应用到菜单栏 tray（热更新）。无自定义则回退默认图标。
/// 把当前设置的自定义图标应用到系统托盘/菜单栏（热更新）。无自定义则回退默认图标。
fn apply_tray_icon(app: &AppHandle, s: &Settings) {
    let image = resolve_icon_image(app, s);
    let icon = image.unwrap_or_else(|| {
        let icon_path = app.path().resource_dir().unwrap_or_default().join("icons/tray_white.png");
        tauri::image::Image::from_path(&icon_path).unwrap_or_else(|_| {
            // 兜底：极小 1x1 透明占位，避免 set_icon 失败
            tauri::image::Image::new_owned(vec![0u8; 4], 1, 1)
        })
    });
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = app.tray_by_id("main").map(|t| t.set_tooltip(Some(app_title(s))));
}

/// 当前生效的 app 名称（自定义为空则用默认 "Health Dashboard"）
fn app_title(s: &Settings) -> String {
    if !s.app_name.trim().is_empty() {
        s.app_name.trim().to_string()
    } else {
        "Health Dashboard".to_string()
    }
}

/// 命令：设置自定义名称 + 图标。icon 为 "preset:<id>" / "base64:..." / ""（仅名称）。
/// 立即热更新菜单栏图标，并持久化。
#[tauri::command]
fn set_app_identity(app: AppHandle, state: tauri::State<SettingsHandle>, name: String, icon: String) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        s.app_name = name;
        s.custom_icon = icon;
    }
    let s = state.clone_inner();
    save_settings_file(&app, &s).map_err(|e| e.to_string())?;
    apply_tray_icon(&app, &s);
    Ok(())
}

/// 命令：重置为默认名称 + 默认图标（清除自定义文件）。
#[tauri::command]
fn reset_app_identity(app: AppHandle, state: tauri::State<SettingsHandle>) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        s.app_name = String::new();
        s.custom_icon = String::new();
    }
    let s = state.clone_inner();
    save_settings_file(&app, &s).map_err(|e| e.to_string())?;
    // 删除自定义图标文件
    let f = custom_icon_file(&app);
    let _ = std::fs::remove_file(&f);
    apply_tray_icon(&app, &s);
    Ok(())
}

/// 命令：返回当前自定义名称 + 自定义图标的 dataURL（前端显示预览用）。
#[tauri::command]
fn get_app_identity(app: AppHandle) -> String {
    let s = load_settings(&app);
    let mut out = serde_json::json!({
        "name": s.app_name,
        "icon": "",
    });
    // 若为 base64 上传，直接回原 dataURL；若 preset，回 base64 PNG 预览
    if let Some(rest) = s.custom_icon.strip_prefix("base64:") {
        out["icon"] = serde_json::json!(format!("data:image/png;base64,{}", rest));
    } else if let Some(rest) = s.custom_icon.strip_prefix("preset:") {
        if let Some(bytes) = preset_icon_bytes(rest) {
            out["icon"] = serde_json::json!(format!("data:image/png;base64,{}", base64_encode(&bytes)));
        }
    } else if let Ok(bytes) = std::fs::read(custom_icon_file(&app)) {
        // 兼容：custom_icon 为空但文件存在（老版本残留），回文件
        out["icon"] = serde_json::json!(format!("data:image/png;base64,{}", base64_encode(&bytes)));
    }
    out.to_string()
}

/// 简易 base64 编码（配合前端预览）
fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(T[(n >> 6) as usize & 63] as char);
        out.push(T[n as usize & 63] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(T[(n >> 6) as usize & 63] as char);
        out.push('=');
    }
    out
}


// 共享刷新间隔（save_settings 可热更新，无需重启采集线程）
struct RefreshState(Arc<Mutex<u64>>);

/// 共享当前设置（菜单回调使用）
struct SettingsHandle(pub Arc<Mutex<Settings>>);
impl SettingsHandle {
    fn set<T: serde::Serialize>(&self, key: &str, val: T) {
        let mut s = self.0.lock().unwrap();
        let mut v = serde_json::to_value(&*s).unwrap();
        v[key] = serde_json::to_value(val).unwrap();
        if let Ok(ns) = serde_json::from_value::<Settings>(v) { *s = ns; }
    }
    fn clone_inner(&self) -> Settings { self.0.lock().unwrap().clone() }
}

#[cfg(target_os = "macos")]
struct MenuStrings {
    show_widget: String,
    theme_sub: String,
    theme_auto: String,
    theme_light: String,
    theme_dark: String,
    style_sub: String,
    style_liquid: String,
    style_pixel: String,
    style_brutal: String,
    style_term: String,
    lang_sub: String,
    lang_zh: String,
    lang_en: String,
    lang_ja: String,
    autostart: String,
    character_sub: String,
    char_qiuqiu: String,
    char_nimbo: String,
    char_twinkle: String,
    char_claw: String,
    char_random: String,
    refresh_sub: String,
    refresh_5: String,
    refresh_15: String,
    refresh_30: String,
    sed_sub: String,
    min_unit: String,
    refresh_now: String,
    open_folder: String,
    setup_wizard: String,
    restart: String,
    quit: String,
}

/// 菜单项句柄：运行时用 set_checked 做确定性单选（radio），不依赖重建时序
struct MenuItems {
    theme_auto: tauri::menu::CheckMenuItem<tauri::Wry>,
    theme_light: tauri::menu::CheckMenuItem<tauri::Wry>,
    theme_dark: tauri::menu::CheckMenuItem<tauri::Wry>,
    style_liquid: tauri::menu::CheckMenuItem<tauri::Wry>,
    style_pixel: tauri::menu::CheckMenuItem<tauri::Wry>,
    style_brutal: tauri::menu::CheckMenuItem<tauri::Wry>,
    style_term: tauri::menu::CheckMenuItem<tauri::Wry>,
    lang_zh: tauri::menu::CheckMenuItem<tauri::Wry>,
    lang_en: tauri::menu::CheckMenuItem<tauri::Wry>,
    lang_ja: tauri::menu::CheckMenuItem<tauri::Wry>,
    refresh_5: tauri::menu::CheckMenuItem<tauri::Wry>,
    refresh_15: tauri::menu::CheckMenuItem<tauri::Wry>,
    refresh_30: tauri::menu::CheckMenuItem<tauri::Wry>,
    sed_30: tauri::menu::CheckMenuItem<tauri::Wry>,
    sed_40: tauri::menu::CheckMenuItem<tauri::Wry>,
    sed_45: tauri::menu::CheckMenuItem<tauri::Wry>,
    sed_60: tauri::menu::CheckMenuItem<tauri::Wry>,
    sed_90: tauri::menu::CheckMenuItem<tauri::Wry>,
    visible: tauri::menu::CheckMenuItem<tauri::Wry>,
    autostart: tauri::menu::CheckMenuItem<tauri::Wry>,
    char_qiuqiu: tauri::menu::CheckMenuItem<tauri::Wry>,
    char_nimbo: tauri::menu::CheckMenuItem<tauri::Wry>,
    char_twinkle: tauri::menu::CheckMenuItem<tauri::Wry>,
    char_claw: tauri::menu::CheckMenuItem<tauri::Wry>,
    char_random: tauri::menu::CheckMenuItem<tauri::Wry>,
}

struct MenuItemsState(pub std::sync::Mutex<Option<MenuItems>>);

/// 背景玻璃视图指针：切「主题」时用它动态改窗口圆角（液态玻璃 36 / 像素动漫风 0）
/// `*mut objc::runtime::Object` 不是 Send/Sync，但本 app 仅 main 线程访问，强制安全。
#[cfg(target_os = "macos")]
struct GlassViewState(pub std::sync::Mutex<Option<*mut objc::runtime::Object>>);
#[cfg(target_os = "macos")]
unsafe impl Send for GlassViewState {}
#[cfg(target_os = "macos")]
unsafe impl Sync for GlassViewState {}

/// 互斥组单选修正：把 on 项勾上、同组其它项取消勾
fn menu_radio(group: &str, on: &str, it: &MenuItems) {
    let set = |mi: &tauri::menu::CheckMenuItem<tauri::Wry>, want: bool| { let _ = mi.set_checked(want); };
    match group {
        "theme" => {
            set(&it.theme_auto, on == "theme_auto");
            set(&it.theme_light, on == "theme_light");
            set(&it.theme_dark, on == "theme_dark");
        }
        "lang" => {
            set(&it.lang_zh, on == "lang_zh");
            set(&it.lang_en, on == "lang_en");
            set(&it.lang_ja, on == "lang_ja");
        }
        "refresh" => {
            set(&it.refresh_5, on == "refresh_5");
            set(&it.refresh_15, on == "refresh_15");
            set(&it.refresh_30, on == "refresh_30");
        }
        "sed" => {
            set(&it.sed_30, on == "sed_30");
            set(&it.sed_40, on == "sed_40");
            set(&it.sed_45, on == "sed_45");
            set(&it.sed_60, on == "sed_60");
            set(&it.sed_90, on == "sed_90");
        }
        "char" => {
            set(&it.char_qiuqiu, on == "char_qiuqiu");
            set(&it.char_nimbo, on == "char_nimbo");
            set(&it.char_twinkle, on == "char_twinkle");
            set(&it.char_claw, on == "char_claw");
            set(&it.char_random, on == "char_random");
        }
        "style" => {
            set(&it.style_liquid, on == "style_liquid");
            set(&it.style_pixel, on == "style_pixel");
            set(&it.style_brutal, on == "style_brutal");
            set(&it.style_term, on == "style_term");
        }
        _ => {}
    }
}

/// 菜单栏文案（跟随当前语言）
#[cfg(target_os = "macos")]
fn menu_strings(lang: &str) -> MenuStrings {
    match lang {
        "en" => MenuStrings {
            show_widget: "Show Widget".into(),
            theme_sub: "Appearance".into(),
            theme_auto: "Follow System".into(),
            theme_light: "Light".into(),
            theme_dark: "Dark".into(),
            style_sub: "Theme".into(),
            style_liquid: "Liquid Glass".into(),
            style_pixel: "Pixel Anime".into(),
            style_brutal: "Brutalist Web".into(),
            style_term: "Developer Terminal".into(),
            lang_sub: "Language".into(),
            lang_zh: "Simplified Chinese".into(),
            lang_en: "English".into(),
            lang_ja: "Japanese".into(),
            autostart: "Launch at Login".into(),
            character_sub: "Companion".into(),
            char_qiuqiu: "Qiuqiu".into(),
            char_nimbo: "Nimbo".into(),
            char_twinkle: "Twinkle".into(),
            char_claw: "Claw".into(),
            char_random: "Shuffle".into(),
            refresh_sub: "Update Interval".into(),
            refresh_5: "5 min".into(),
            refresh_15: "15 min".into(),
            refresh_30: "30 min".into(),
            sed_sub: "Sedentary Reminder".into(),
            min_unit: "min".into(),
            refresh_now: "Refresh Now".into(),
            open_folder: "Open Data Folder".into(),
            setup_wizard: "Settings…".into(),
            restart: "Restart".into(),
            quit: "Quit".into(),
        },
        "ja" => MenuStrings {
            show_widget: "ウィジェットを表示".into(),
            theme_sub: "外観".into(),
            theme_auto: "システムに従う".into(),
            theme_light: "ライト".into(),
            theme_dark: "ダーク".into(),
            style_sub: "テーマ".into(),
            style_liquid: "リキッドガラス".into(),
            style_pixel: "ピクセルアニメ".into(),
            style_brutal: "ブルータリストウェブ".into(),
            style_term: "デベロッパーターミナル".into(),
            lang_sub: "言語".into(),
            lang_zh: "简体中文".into(),
            lang_en: "English".into(),
            lang_ja: "日本語".into(),
            autostart: "ログイン時に起動".into(),
            character_sub: "キャラクター".into(),
            char_qiuqiu: "球球".into(),
            char_nimbo: "雲宝".into(),
            char_twinkle: "亮亮".into(),
            char_claw: "鉗鉗".into(),
            char_random: "ランダム".into(),
            refresh_sub: "更新間隔".into(),
            refresh_5: "5 分".into(),
            refresh_15: "15 分".into(),
            refresh_30: "30 分".into(),
            sed_sub: "座りっぱなし通知".into(),
            min_unit: "分".into(),
            refresh_now: "今すぐ更新".into(),
            open_folder: "データフォルダを開く".into(),
            setup_wizard: "設定…".into(),
            restart: "再起動".into(),
            quit: "終了".into(),
        },
        _ => MenuStrings {
            show_widget: "显示小组件".into(),
            theme_sub: "外观".into(),
            theme_auto: "跟随系统".into(),
            theme_light: "浅色模式".into(),
            theme_dark: "深色模式".into(),
            style_sub: "主题".into(),
            style_liquid: "液态玻璃".into(),
            style_pixel: "像素动漫风".into(),
            style_brutal: "网页粗野主义".into(),
            style_term: "开发者终端".into(),
            lang_sub: "语言".into(),
            lang_zh: "简体中文".into(),
            lang_en: "English".into(),
            lang_ja: "日本語".into(),
            autostart: "登录时启动".into(),
            character_sub: "桌搭伙伴".into(),
            char_qiuqiu: "球球".into(),
            char_nimbo: "云宝".into(),
            char_twinkle: "亮亮".into(),
            char_claw: "钳钳".into(),
            char_random: "随机".into(),
            refresh_sub: "更新频率".into(),
            refresh_5: "5 分钟".into(),
            refresh_15: "15 分钟".into(),
            refresh_30: "30 分钟".into(),
            sed_sub: "久坐提醒".into(),
            min_unit: "分钟".into(),
            refresh_now: "立即刷新".into(),
            open_folder: "打开数据目录".into(),
            setup_wizard: "设置…".into(),
            restart: "重新启动".into(),
            quit: "退出".into(),
        },
    }
}

/// 重启应用：先让 shell 在后台延迟 open 新实例（避开 single-instance 接管），
/// 再退出当前进程。sleep 1s 保证旧进程已退出，新实例不会被 single-instance 移交拦截。
/// 致命坑：绝不能 std::thread::spawn(sleep).exit —— exit 会连 sleep 线程一起杀掉，open 永不执行。
#[cfg(target_os = "macos")]
fn relaunch(app: &AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        // exe = /Applications/xxx.app/Contents/MacOS/xxx
        if let Some(bundle) = exe
            .parent()      // MacOS
            .and_then(|p| p.parent())  // Contents
            .and_then(|p| p.parent())  // xxx.app
        {
            let script = format!("sleep 1; open '{}'", bundle.display());
            let _ = std::process::Command::new("sh").arg("-c").arg(script).spawn();
        }
    }
    app.exit(0);
}

#[cfg(not(target_os = "macos"))]
fn relaunch(app: &AppHandle) {
    app.exit(0);
}

fn build_main_menu(app: &AppHandle, s: &Settings) -> tauri::menu::Menu<tauri::Wry> {
    use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let m = menu_strings(&s.language);

    // ── 桌搭伙伴子菜单 ──
    let char_qiuqiu  = CheckMenuItem::with_id(app, "char_qiuqiu",  &m.char_qiuqiu,  true, s.character == "qiuqiu",  None::<&str>).unwrap();
    let char_nimbo   = CheckMenuItem::with_id(app, "char_nimbo",   &m.char_nimbo,   true, s.character == "nimbo",   None::<&str>).unwrap();
    let char_twinkle = CheckMenuItem::with_id(app, "char_twinkle", &m.char_twinkle, true, s.character == "twinkle", None::<&str>).unwrap();
    let char_claw    = CheckMenuItem::with_id(app, "char_claw",    &m.char_claw,    true, s.character == "claw",    None::<&str>).unwrap();
    let char_random  = CheckMenuItem::with_id(app, "char_random",  &m.char_random,  true, s.character == "random",  None::<&str>).unwrap();
    let char_sub = Submenu::with_id_and_items(
        app, "char_menu", &m.character_sub, true,
        &[&char_random, &char_qiuqiu, &char_nimbo, &char_twinkle, &char_claw]
    ).unwrap();

    // ── 视觉主题子菜单（仅换皮肤：液态玻璃 / 像素动漫风）──
    let style_liquid = CheckMenuItem::with_id(app, "style_liquid", &m.style_liquid, true, s.style == "liquid-glass", None::<&str>).unwrap();
    let style_pixel  = CheckMenuItem::with_id(app, "style_pixel",  &m.style_pixel,  true, s.style == "pixel-anime",  None::<&str>).unwrap();
    let style_brutal = CheckMenuItem::with_id(app, "style_brutal", &m.style_brutal, true, s.style == "brutalist-web", None::<&str>).unwrap();
    let style_term   = CheckMenuItem::with_id(app, "style_term",   &m.style_term,   true, s.style == "developer-terminal", None::<&str>).unwrap();
    let style_sub = Submenu::with_id_and_items(
        app, "style_menu", &m.style_sub, true,
        &[&style_liquid, &style_pixel, &style_brutal, &style_term]
    ).unwrap();

    // ── 外观子菜单（明暗）──
    let theme_auto  = CheckMenuItem::with_id(app, "theme_auto",  &m.theme_auto,  true, s.theme == "auto",  None::<&str>).unwrap();
    let theme_light = CheckMenuItem::with_id(app, "theme_light", &m.theme_light, true, s.theme == "light", None::<&str>).unwrap();
    let theme_dark  = CheckMenuItem::with_id(app, "theme_dark",  &m.theme_dark,  true, s.theme == "dark",  None::<&str>).unwrap();
    let theme_sub = Submenu::with_id_and_items(
        app, "theme_menu", &m.theme_sub, true,
        &[&theme_auto, &theme_light, &theme_dark]
    ).unwrap();

    // ── 语言子菜单 ──
    let lang_zh = CheckMenuItem::with_id(app, "lang_zh", &m.lang_zh, true, s.language == "zh-CN", None::<&str>).unwrap();
    let lang_en = CheckMenuItem::with_id(app, "lang_en", &m.lang_en,   true, s.language == "en",    None::<&str>).unwrap();
    let lang_ja = CheckMenuItem::with_id(app, "lang_ja", &m.lang_ja,    true, s.language == "ja",    None::<&str>).unwrap();
    let lang_sub = Submenu::with_id_and_items(
        app, "lang_menu", &m.lang_sub, true,
        &[&lang_zh, &lang_en, &lang_ja]
    ).unwrap();

    // ── 刷新间隔子菜单 ──
    let refresh_5  = CheckMenuItem::with_id(app, "refresh_5",  &m.refresh_5,  true, s.refresh_interval_min == 5,  None::<&str>).unwrap();
    let refresh_15 = CheckMenuItem::with_id(app, "refresh_15", &m.refresh_15, true, s.refresh_interval_min == 15, None::<&str>).unwrap();
    let refresh_30 = CheckMenuItem::with_id(app, "refresh_30", &m.refresh_30, true, s.refresh_interval_min == 30, None::<&str>).unwrap();
    let refresh_sub = Submenu::with_id_and_items(
        app, "refresh_menu", &m.refresh_sub, true,
        &[&refresh_5, &refresh_15, &refresh_30]
    ).unwrap();

    // ── 久坐提醒子菜单（阈值 30/40/45/60/90 直接平铺）──
    let sed_30 = CheckMenuItem::with_id(app, "sed_30", &format!("{} {}", 30, m.min_unit), true, s.sedentary_min == 30, None::<&str>).unwrap();
    let sed_40 = CheckMenuItem::with_id(app, "sed_40", &format!("{} {}", 40, m.min_unit), true, s.sedentary_min == 40, None::<&str>).unwrap();
    let sed_45 = CheckMenuItem::with_id(app, "sed_45", &format!("{} {}", 45, m.min_unit), true, s.sedentary_min == 45, None::<&str>).unwrap();
    let sed_60 = CheckMenuItem::with_id(app, "sed_60", &format!("{} {}", 60, m.min_unit), true, s.sedentary_min == 60, None::<&str>).unwrap();
    let sed_90 = CheckMenuItem::with_id(app, "sed_90", &format!("{} {}", 90, m.min_unit), true, s.sedentary_min == 90, None::<&str>).unwrap();
    let sed_sub = Submenu::with_id_and_items(
        app, "sed_menu", &m.sed_sub, true,
        &[&sed_30, &sed_40, &sed_45, &sed_60, &sed_90]
    ).unwrap();

    // ── 基础项 ──
    let toggle_visible = CheckMenuItem::with_id(app, "toggle_visible", &m.show_widget, true, s.widget_visible, None::<&str>).unwrap();
    let autostart  = CheckMenuItem::with_id(app, "toggle_autostart", &m.autostart,  true, s.autostart,    None::<&str>).unwrap();
    let refresh_now = MenuItem::with_id(app, "refresh_now",  &m.refresh_now,  true, Some("R")).unwrap();
    let open_folder = MenuItem::with_id(app, "open_data_folder", &m.open_folder,  true, None::<&str>).unwrap();
    let setup_wizard_item = MenuItem::with_id(app, "open_setup", &m.setup_wizard, true, None::<&str>).unwrap();
    let restart_item      = MenuItem::with_id(app, "restart", &m.restart, true, None::<&str>).unwrap();
    let quit        = MenuItem::with_id(app, "quit",        &m.quit,             true, Some("Q")).unwrap();
    let sep = PredefinedMenuItem::separator(app).unwrap();

    // 分组顺序：窗口 → 操作 → 个性化 → 提醒与数据 → 配置 → 维护 → 退出（隔离沉底）
    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
    items.push(&toggle_visible);      // 窗口：高频开关
    items.push(&refresh_now);         // 操作：立即刷新
    items.push(&sep);
    items.push(&char_sub);            // 个性化：桌搭伙伴 / 主题 / 外观 / 语言
    items.push(&style_sub);
    items.push(&theme_sub);
    items.push(&lang_sub);
    items.push(&sep);
    items.push(&sed_sub);             // 提醒与数据
    items.push(&refresh_sub);
    items.push(&sep);
    items.push(&setup_wizard_item);   // 配置
    items.push(&open_folder);
    items.push(&sep);
    items.push(&autostart);           // 维护
    items.push(&restart_item);
    items.push(&sep);
    items.push(&quit);                // 退出：单独隔离，避免误点
    let menu = Menu::with_items(app, &items).unwrap();

    // 保存句柄供 on_menu_event 用 set_checked 做确定性单选
    if let Some(st) = app.try_state::<MenuItemsState>() {
        *st.0.lock().unwrap() = Some(MenuItems {
            theme_auto, theme_light, theme_dark,
            style_liquid, style_pixel, style_brutal, style_term,
            lang_zh, lang_en, lang_ja,
            refresh_5, refresh_15, refresh_30,
            sed_30, sed_40, sed_45, sed_60, sed_90,
            visible: toggle_visible,
            autostart,
            char_qiuqiu, char_nimbo, char_twinkle, char_claw, char_random,
        });
    }

    menu
}

/// 重建菜单栏菜单：文案跟随当前语言，勾选态跟随当前设置。
/// 修复此前 emit("menu-rebuild") 无人消费导致菜单勾选态错乱的问题。
fn rebuild_tray_menu(app: &AppHandle) {
    let sh = app.state::<SettingsHandle>();
    let s = sh.clone_inner();
    let menu = build_main_menu(app, &s);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
    }
}

/// 关掉 NSWindow 系统阴影，保留液态玻璃/ vibrancy 的折射光晕。
/// NSGlassEffectView / NSVisualEffectView 通过 layer.shadow* 实现折射/高光，
/// 这是液态玻璃的核心视觉特征，不能关。只关 NSWindow 自身的 setHasShadow。
#[cfg(target_os = "macos")]
/// 切主题时动态调整窗口圆角：液态玻璃 36 / 实底硬边风格（像素动漫 / 网页粗野主义 / 开发者终端）0
#[cfg(target_os = "macos")]
fn style_corner_radius(style: &str) -> f64 {
    match style {
        "pixel-anime" | "brutalist-web" | "developer-terminal" => 0.0,
        _ => 36.0,
    }
}
#[cfg(target_os = "macos")]
fn apply_window_style(app: &AppHandle, style: &str) {
    let radius: f64 = style_corner_radius(style);
    unsafe {
        use objc::{msg_send, sel, sel_impl};
        use objc::runtime::Object;
        if let Some(p) = app.try_state::<GlassViewState>() {
            if let Some(ptr) = *p.inner().0.lock().unwrap() {
                let glass: *mut Object = ptr;
                let _: () = msg_send![glass, setCornerRadius: radius];
            }
        }
    }
}

fn disable_window_shadow(win: &tauri::WebviewWindow) {
    use objc::{msg_send, sel, sel_impl};
    if let Ok(ns) = win.ns_window() {
        let ns = ns as *mut objc::runtime::Object;
        unsafe {
            let _: () = msg_send![ns, setHasShadow: false];
        }
    }
}

/// 根据 widget_visible 同步主窗口显隐；先 show 再定位，位置 clamp 到可见屏幕内。
#[cfg(target_os = "macos")]
fn sync_main_widget(app: &AppHandle, s: &Settings) {
    if let Some(win) = app.get_webview_window("main") {
        if s.widget_visible {
            let _ = win.show();
            // macOS 坑：desktop level + Accessory 激活策略下，hide() 后 show() 有时不恢复显示。
            // 用 orderFrontRegardless 无视应用激活状态强制前置，并重设窗口层级/去阴影。
            #[cfg(target_os = "macos")]
            unsafe {
                use objc::{msg_send, sel, sel_impl};
                use objc::runtime::Object;
                if let Ok(ns) = win.ns_window() {
                    let ns = ns as *mut Object;
                    let _: () = msg_send![ns, setLevel: -2147483602i64];
                    let _: () = msg_send![ns, orderFrontRegardless];
                }
                disable_window_shadow(&win);
            }
            let (cx, cy) = clamp_to_screens(s.pos_x, s.pos_y, &collect_displays(), 344, 272);
            // pos_x/pos_y 是逻辑点，必须用 LogicalPosition（用 PhysicalPosition 会在 Retina 上再除一次 scale）
            let _ = win.set_position(tauri::LogicalPosition::new(cx as f64, cy as f64));
            // 保存修正后的坐标
            if cx != s.pos_x || cy != s.pos_y {
                let sh = app.state::<SettingsHandle>();
                sh.set("pos_x", cx);
                sh.set("pos_y", cy);
                let _ = save_settings_file(app, &sh.clone_inner());
            }
        } else {
            let _ = win.hide();
        }
    }
}

/// 把窗口坐标 clamp 到最近的屏幕内，防止移到屏幕外不可见。
#[cfg(target_os = "macos")]
fn clamp_to_screens(x: i32, y: i32, displays: &[serde_json::Value], w: i32, h: i32) -> (i32, i32) {
    if displays.is_empty() {
        return (x, y);
    }
    // 找窗口中心点所在的屏幕（或重叠最多的屏幕）
    let mut best = None;
    let mut best_overlap: i32 = 0;
    for d in displays {
        let dx = d["x"].as_i64().unwrap_or(0) as i32;
        let dy = d["y"].as_i64().unwrap_or(0) as i32;
        let dw = d["width"].as_i64().unwrap_or(0) as i32;
        let dh = d["height"].as_i64().unwrap_or(0) as i32;
        let ox = (x + w).min(dx + dw) - x.max(dx);
        let oy = (y + h).min(dy + dh) - y.max(dy);
        let overlap = if ox > 0 && oy > 0 { ox * oy } else { 0 };
        if overlap > best_overlap {
            best_overlap = overlap;
            best = Some((dx, dy, dw, dh));
        }
    }
    // 如果不在任何屏幕上，选第一块屏幕
    let (sx, sy, sw, sh) = best.unwrap_or_else(|| {
        let d = &displays[0];
        (
            d["x"].as_i64().unwrap_or(0) as i32,
            d["y"].as_i64().unwrap_or(0) as i32,
            d["width"].as_i64().unwrap_or(1920) as i32,
            d["height"].as_i64().unwrap_or(1080) as i32,
        )
    });
    let cx = x.max(sx + 4).min(sx + sw - w - 4);
    let cy = y.max(sy + 4).min(sy + sh - h - 4);
    (cx, cy)
}

/// 按增量移动主窗口，clamp 到屏幕内，保存新位置。
// move_win_by 已移除：菜单不再提供「移动」功能（窗口位置固定）
/// 菜单栏回调用的全局 AppHandle（setup 时写入，回调里读取）
#[cfg(target_os = "macos")]
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// 仅用于防止 ARC drop 的无操作占位（retain 已由 msg_send 调用，Box::leak 防止释放）
#[cfg(target_os = "macos")]
struct _StatusItemGuard(*mut std::ffi::c_void);

/// 解析关键路径：(python 脚本, data.json, token, config)
fn paths(app: &AppHandle) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let res = app.path().resource_dir().expect("resource_dir");
    let py_candidates = [
        res.join("resources").join("fetch_standalone.py"),
        res.join("fetch_standalone.py"),
    ];
    let py = py_candidates
        .into_iter()
        .find(|p| p.exists())
        .expect("fetch_standalone.py not found in resources");

    let data = app
        .path()
        .app_data_dir()
        .expect("app_data_dir")
        .join("data.json");

    let home = app.path().home_dir().expect("home_dir");
    let tok = home.join(".google-health-mcp").join("tokens.json");
    let cfg = home.join(".google-health-mcp").join("config.json");

    (py, data, tok, cfg)
}

/// 运行一次 Python 采集（写 data.json）
fn run_fetch_once(py: &Path, data: &Path, tok: &Path, cfg: &Path, sed_min: u64, remind_min: u64) -> std::io::Result<()> {
    if let Some(parent) = data.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Windows 上 Python 启动器命令为 python（python3 不存在），Linux/macOS 为 python3
    #[cfg(target_os = "windows")]
    let py_cmd = if std::process::Command::new("python").arg("--version").output().map(|o| o.status.success()).unwrap_or(false) { "python" } else { "py" };
    #[cfg(not(target_os = "windows"))]
    let py_cmd = "python3";
    let status = Command::new(py_cmd)
        .arg(py)
        .arg("--once")
        .arg("--out")
        .arg(data)
        .arg("--token")
        .arg(tok)
        .arg("--config")
        .arg(cfg)
        .arg("--sed-min")
        .arg(sed_min.to_string())
        .arg("--remind-min")
        .arg(remind_min.to_string())
        .status()?;
    if !status.success() {
        eprintln!("[health] python fetch exited with {:?}", status.code());
    }
    Ok(())
}

// ── macOS 几何类型（objc 0.2.7 无 foundation 模块，需自定义 Encode）─────────────
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSPoint {
    x: f64,
    y: f64,
}
#[cfg(target_os = "macos")]
unsafe impl Encode for NSPoint {
    fn encode() -> Encoding {
        unsafe { Encoding::from_str("{CGPoint=dd}") }
    }
}
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSSize {
    width: f64,
    height: f64,
}
#[cfg(target_os = "macos")]
unsafe impl Encode for NSSize {
    fn encode() -> Encoding {
        unsafe { Encoding::from_str("{CGSize=dd}") }
    }
}
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}
#[cfg(target_os = "macos")]
unsafe impl Encode for NSRect {
    fn encode() -> Encoding {
        unsafe { Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
    }
}

/// 当前 macOS 外观是否为深色
#[cfg(target_os = "macos")]
fn current_appearance_dark() -> bool {
    unsafe {
        let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() {
            return true;
        }
        let eff: *mut Object = msg_send![app, effectiveAppearance];
        if eff.is_null() {
            return true;
        }
        let name: *mut Object = msg_send![eff, name];
        if name.is_null() {
            return true;
        }
        let utf8: *const c_char = msg_send![name, UTF8String];
        if utf8.is_null() {
            return true;
        }
        let s = CStr::from_ptr(utf8).to_string_lossy().to_lowercase();
        s.contains("dark")
    }
}
#[cfg(not(target_os = "macos"))]
fn current_appearance_dark() -> bool {
    true
}

/// 勿扰（Focus / DND）是否开启
///
/// 【为什么要改】旧实现依赖私有框架 `FocusStatus`（`FocusStatusCenter.isActive`）。
/// macOS 26 (Tahoe) 已移除该框架 —— 实测 `dlopen` 失败、`NSClassFromString` 返回 nil，
/// 于是恒返回 false：用户开着系统专注模式，久坐提醒照样弹，等于「勿扰不同步」。
///
/// 【为什么不用读 DND 数据库】`~/Library/DoNotDisturb/DB/*.json` 确实记录了 Focus 状态，
/// 但该目录受 TCC 保护，第三方 app 读取需要「完全磁盘访问权限」——桌面小组件不该要这个权限。
///
/// 【现方案】监听 NSDistributedNotificationCenter 上 Control Center 广播的
///   `_NSDoNotDisturbEnabledNotification` / `_NSDoNotDisturbDisabledNotification`。
/// 无需任何权限，且是实时的（开/关专注模式立刻同步）。
/// 在尚未收到任何广播前（例如旧系统），退回旧的私有框架探测作为兜底。
#[cfg(target_os = "macos")]
fn is_dnd_active() -> bool {
    if DND_KNOWN.load(Ordering::SeqCst) {
        DND_ACTIVE.load(Ordering::SeqCst)
    } else {
        // 还没收到过广播（比如 app 启动时专注模式已经开着 —— 没有状态变化就不会有广播）。
        // 尽力读一次 DND 数据库拿初始状态；该目录受 TCC 保护，读不到就静默退回旧探测。
        dnd_read_db().unwrap_or_else(dnd_legacy_focus_probe)
    }
}

/// 读 ~/Library/DoNotDisturb/DB/Assertions.json 判断当前是否有活跃的 Focus 断言。
/// 受 TCC「完全磁盘访问」保护：没有权限时返回 None（不报错、不弹权限框）。
#[cfg(target_os = "macos")]
fn dnd_read_db() -> Option<bool> {
    let home = std::env::var("HOME").ok()?;
    let p = std::path::PathBuf::from(home).join("Library/DoNotDisturb/DB/Assertions.json");
    let s = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let recs = v.get("data")?.get(0)?.get("storeAssertionRecords")?.as_array()?;
    Some(!recs.is_empty())
}

/// 旧兜底：私有框架 FocusStatus（macOS 12–15 可用，macOS 26 起该框架已被移除）
#[cfg(target_os = "macos")]
fn dnd_legacy_focus_probe() -> bool {
    unsafe {
        let path =
            std::ffi::CString::new("/System/Library/PrivateFrameworks/FocusStatus.framework/FocusStatus")
                .expect("cstr");
        let _ = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
        if let Some(cls) = Class::get("FocusStatusCenter") {
            let center: *mut Object = msg_send![cls, defaultCenter];
            if !center.is_null() {
                let active: BOOL = msg_send![center, isActive];
                return active == objc::runtime::YES;
            }
        }
    }
    false
}

#[cfg(target_os = "macos")]
static DND_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 是否已经收到过至少一次系统广播（收到后不再走旧兜底）
#[cfg(target_os = "macos")]
static DND_KNOWN: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static DND_START: Once = Once::new();
#[cfg(target_os = "macos")]
static DND_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
fn dnd_set(active: bool) {
    DND_ACTIVE.store(active, Ordering::SeqCst);
    DND_KNOWN.store(true, Ordering::SeqCst);
    eprintln!(
        "[health] 系统勿扰 → {}",
        if active { "开启（抑制久坐提醒）" } else { "关闭（恢复提醒）" }
    );
    if let Some(h) = DND_HANDLE.get() {
        let _ = h.emit("dnd-changed", active);
    }
}

#[cfg(target_os = "macos")]
extern "C" fn hd_dnd_enabled(_this: *mut Object, _cmd: Sel, _note: *mut Object) {
    dnd_set(true);
}
#[cfg(target_os = "macos")]
extern "C" fn hd_dnd_disabled(_this: *mut Object, _cmd: Sel, _note: *mut Object) {
    dnd_set(false);
}

/// 构造 NSString（不释放，进程生命周期内常驻，仅用于注册观察者时的一次性名称）
#[cfg(target_os = "macos")]
fn ns_string(s: &str) -> *mut Object {
    unsafe {
        let cs = match std::ffi::CString::new(s) {
            Ok(c) => c,
            Err(_) => return std::ptr::null_mut(),
        };
        let cls = match Class::get("NSString") {
            Some(c) => c,
            None => return std::ptr::null_mut(),
        };
        let alloc: *mut Object = msg_send![cls, alloc];
        msg_send![alloc, initWithUTF8String: cs.as_ptr() as *mut std::os::raw::c_char]
    }
}

#[cfg(target_os = "macos")]
fn start_dnd_observer(handle: AppHandle) {
    let _ = DND_HANDLE.set(handle);
    DND_START.call_once(|| {
        std::thread::Builder::new()
            .name("dnd-observer".to_string())
            .spawn(dnd_observer_main)
            .ok();
    });
}

#[cfg(target_os = "macos")]
fn dnd_observer_main() {
    use objc::runtime::{
        class_addMethod, objc_allocateClassPair, objc_registerClassPair, sel_registerName, Imp,
    };
    use std::os::raw::c_char;

    unsafe {
        let nsobj = match Class::get("NSObject") {
            Some(c) => c,
            None => {
                eprintln!("[health] DND 观察者：NSObject 缺失");
                return;
            }
        };
        let cls = objc_allocateClassPair(
            nsobj,
            b"HdDndObserver\0".as_ptr() as *const c_char,
            0,
        );
        if cls.is_null() {
            eprintln!("[health] DND 观察者：创建类失败");
            return;
        }
        let ty = b"v@:@\0".as_ptr() as *const c_char;
        let imp_on: Imp = std::mem::transmute(hd_dnd_enabled as extern "C" fn(*mut Object, Sel, *mut Object));
        let imp_off: Imp = std::mem::transmute(hd_dnd_disabled as extern "C" fn(*mut Object, Sel, *mut Object));
        let sel_on = std::ffi::CString::new("hdDndOn:").unwrap();
        let sel_off = std::ffi::CString::new("hdDndOff:").unwrap();
        class_addMethod(cls, sel_registerName(sel_on.as_ptr()), imp_on, ty);
        class_addMethod(cls, sel_registerName(sel_off.as_ptr()), imp_off, ty);
        objc_registerClassPair(cls);

        let obs_cls = match Class::get("HdDndObserver") {
            Some(c) => c,
            None => return,
        };
        // 观察者对象不释放：NSDistributedNotificationCenter 不 retain 观察者
        let observer: *mut Object = msg_send![obs_cls, new];

        let center: *mut Object = match Class::get("NSDistributedNotificationCenter") {
            Some(c) => msg_send![c, defaultCenter],
            None => {
                eprintln!("[health] DND 观察者：NSDistributedNotificationCenter 缺失");
                return;
            }
        };

        let nil_obj: *mut Object = std::ptr::null_mut();
        for (name, selname) in [
            ("_NSDoNotDisturbEnabledNotification", "hdDndOn:"),
            ("_NSDoNotDisturbDisabledNotification", "hdDndOff:"),
        ] {
            let n = ns_string(name);
            let s = std::ffi::CString::new(selname).unwrap();
            let sel = sel_registerName(s.as_ptr());
            let _: () = msg_send![center, addObserver: observer selector: sel name: n object: nil_obj];
        }
        eprintln!("[health] DND 观察者已注册：监听系统勿扰广播（无需权限）");

        // 分布式通知靠 run loop 投递，线程必须保持 run loop 运行
        let rl: *mut Object = match Class::get("NSRunLoop") {
            Some(c) => msg_send![c, currentRunLoop],
            None => return,
        };
        let _: () = msg_send![rl, run];
    }
}
#[cfg(not(target_os = "macos"))]
fn is_dnd_active() -> bool {
    false
}

/// 登录项自启：macOS 通过 System Events（显示在系统设置 > 登录项）；
/// Windows 通过注册表 HKCU\...\Run 键（显示在 任务管理器 > 启动应用）
fn set_autostart(enabled: bool) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_SET_VALUE | KEY_READ)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        if enabled {
            // 当前 exe 路径写入 Run 键
            let exe = std::env::current_exe()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            key.set_value("HealthDashboard", &exe.to_string_lossy().to_string())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            eprintln!("[health] autostart enabled via registry Run key");
        } else {
            let _ = key.delete_value("HealthDashboard");
            eprintln!("[health] autostart removed from registry");
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
    let app_path = "/Applications/Health Dashboard.app";

    // 先清理旧的 LaunchAgent plist（已废弃，改用 System Events）
    let old_plist = {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        Path::new(&home)
            .join("Library")
            .join("LaunchAgents")
            .join("com.arrhealth.healthdashboard.plist")
    };
    if old_plist.exists() {
        let _ = Command::new("/bin/launchctl")
            .args(["unload", old_plist.to_str().unwrap()])
            .status();
        let _ = std::fs::remove_file(&old_plist);
    }

    if enabled {
        // 先删除同名条目（防重复）
        let rm_script = r#"tell application "System Events" to try
    delete login item "Health Dashboard"
end try"#;
        let _ = Command::new("osascript").args(["-e", rm_script]).status();

        // 再添加
        let add_script = format!(
            r#"tell application "System Events" to make login item at end with properties {{path:"{}", hidden:true}}"#,
            app_path,
        );
        let status = Command::new("osascript").args(["-e", &add_script]).status()?;
        if !status.success() {
            eprintln!("[health] failed to add login item via System Events");
        } else {
            eprintln!("[health] login item added (visible in System Settings > Login Items)");
        }
    } else {
        let rm_script = r#"tell application "System Events" to try
    delete login item "Health Dashboard"
end try"#;
        let _ = Command::new("osascript").args(["-e", rm_script]).status();
        eprintln!("[health] login item removed");
    }

    Ok(())
    }
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────
#[tauri::command]
fn read_data(app: AppHandle) -> Result<String, String> {
    let (_, data, _, _) = paths(&app);
    match std::fs::read_to_string(&data) {
        Ok(s) if !s.trim().is_empty() => Ok(s),
        _ => Ok("{\"today\":{},\"history\":[]}".to_string()),
    }
}

#[tauri::command]
fn refresh_now(app: AppHandle) -> Result<(), String> {
    refresh_data(&app);
    Ok(())
}

/// LLM 代理调用：WKWebView 里前端直接 fetch 外部 LLM 会被 CORS 预检拦截
/// （如方舟 coding 端点的 allow-headers 不含 Authorization），改由 Rust 侧
/// 用系统 curl 发请求，无 CORS 限制。messages 为 JSON 数组字符串。
#[tauri::command]
async fn ai_chat(
    base_url: String,
    api_key: String,
    model: String,
    messages: String,
    max_tokens: u32,
) -> Result<String, String> {
    // 关键：同步 command 默认跑在 Tauri 主线程，curl 阻塞最长 20s 会把主线程卡死，
    // 表现为「点刷新后 UI 假死 + 透明窗口白屏」。改成 async + spawn_blocking，
    // 把阻塞的 curl 丢到专用线程池，主线程立即返回，UI 不再被卡住。
    tauri::async_runtime::spawn_blocking(move || {
        ai_chat_blocking(&base_url, &api_key, &model, &messages, max_tokens)
    })
    .await
    .map_err(|e| format!("task join error: {}", e))?
}

fn ai_chat_blocking(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let msgs: serde_json::Value =
        serde_json::from_str(messages).map_err(|e| format!("messages JSON 无效: {}", e))?;
    let body = serde_json::json!({
        "model": model,
        "messages": msgs,
        "temperature": 0.9,
        "max_tokens": if max_tokens > 0 { max_tokens } else { 1024 },
    })
    .to_string();

    let out = std::process::Command::new("curl")
        .arg("-s")
        .arg("--connect-timeout")
        .arg("5")
        .arg("--max-time")
        .arg("20")
        // 强制直连：GUI 进程可能继承 HTTP_PROXY 环境变量，而本机对 Ark/Google
        // 直连才是通的（走代理反而拿不到响应）。延迟测试与日常 AI 调用都走这里。
        .arg("--noproxy")
        .arg("*")
        .arg("-X")
        .arg("POST")
        .arg(&url)
        .arg("-H")
        .arg("Content-Type: application/json")
        .arg("-H")
        .arg(format!("Authorization: Bearer {}", api_key))
        .arg("--data-binary")
        .arg(&body)
        .output()
        .map_err(|e| format!("curl 启动失败: {}", e))?;

    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        println!("[ai_chat] {} curl exit {} stderr={}", url, code, String::from_utf8_lossy(&out.stderr));
        return Err(format!("curl exit {}", code));
    }
    let resp = String::from_utf8_lossy(&out.stdout).to_string();
    println!("[ai_chat] {} -> {} bytes", url, resp.len());
    Ok(resp)
}

/// 非阻塞刷新：后台线程跑 Python 采集，立即返回。
fn refresh_data(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let (py, data, tok, cfg) = paths(&app);
        let (sed_min, remind_min) = {
            let sh = app.state::<SettingsHandle>();
            let g = sh.0.lock().unwrap();
            (g.sedentary_min, g.sedentary_remind_min)
        };
        let _ = run_fetch_once(&py, &data, &tok, &cfg, sed_min, remind_min);
    });
}

/// 探测 Google Health API（设置面板「数据 API」延迟测试用）。
/// 复用采集脚本的 token 刷新逻辑，只打一次轻量请求，返回 JSON：
/// {"ok":bool,"ms":int,"detail":str}
/// 必须 async + spawn_blocking：同步 command 跑在主线程，网络阻塞会导致界面假死/白屏。
#[tauri::command]
async fn test_data_api(app: AppHandle) -> Result<String, String> {
    // 同步 command 会卡主线程（curl 阻塞 20s 那次白屏的教训），必须 spawn_blocking
    tauri::async_runtime::spawn_blocking(move || data_api_ping_blocking(&app))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 数据 API 探测（同步版）。供 Tauri command 与 setup 网页 HTTP 端点共用。
/// 注意：只能在非主线程调用（HTTP handler 跑在独立线程，安全；command 侧用 spawn_blocking 包一层）。
fn data_api_ping_blocking(app: &AppHandle) -> Result<String, String> {
    let (py, _data, tok, cfg) = paths(app);
    let out = std::process::Command::new("python3")
        .arg(py)
        .arg("--ping")
        .arg("--token")
        .arg(tok)
        .arg("--config")
        .arg(cfg)
        .output()
        .map_err(|e| format!("启动 python 失败: {}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    // --ping 下脚本日志走 stderr，stdout 只应有结果行；取最后一个 JSON 行以防万一
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("")
        .to_string();
    if line.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let last = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .last()
            .unwrap_or("未知错误")
            .to_string();
        return Err(if last.is_empty() { "无响应".to_string() } else { last });
    }
    Ok(line)
}

/// LLM API 探测：发一条最小请求，测连通性与往返延迟，返回 {ok, ms, detail}
fn llm_api_ping_blocking(base_url: &str, api_key: &str, model: &str) -> String {
    if base_url.trim().is_empty() || api_key.trim().is_empty() {
        return serde_json::json!({"ok": false, "ms": 0, "detail": "未填写 Base URL 或 API Key"}).to_string();
    }
    let model = if model.trim().is_empty() { "gpt-4o-mini" } else { model };
    let msgs = r#"[{"role":"user","content":"hi"}]"#;
    let t0 = std::time::Instant::now();
    let res = ai_chat_blocking(base_url, api_key, model, msgs, 16);
    let ms = t0.elapsed().as_millis();
    match res {
        Ok(resp) => {
            let ok = serde_json::from_str::<serde_json::Value>(&resp)
                .ok()
                .and_then(|v| v.get("choices").and_then(|c| c.as_array()).map(|a| !a.is_empty()))
                .unwrap_or(false);
            if ok {
                serde_json::json!({"ok": true, "ms": ms, "detail": "HTTP 200 · 模型响应正常"}).to_string()
            } else {
                let snippet: String = resp.chars().take(140).collect();
                serde_json::json!({"ok": false, "ms": ms, "detail": format!("返回异常：{}", snippet)}).to_string()
            }
        }
        Err(e) => serde_json::json!({"ok": false, "ms": ms, "detail": e}).to_string(),
    }
}

#[tauri::command]
fn reset_sedentary(app: AppHandle) -> Result<(), String> {
    // 用户点"站起来了"：立刻重置久坐数值（即时反馈），同时记录 ack 时间+基线步数。
    // 下次 Python check_sedentary 对比步数：步数增加 → 保持重置；步数不变 → 回滚并继续累计。
    let (_, data, _, _) = paths(&app);
    let content = std::fs::read_to_string(&data).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let today = v["today"]["date"].as_str().unwrap_or("").to_string();
    let steps = v["today"]["steps"].clone();

    if let Some(hist) = v.get_mut("history").and_then(|h| h.as_array_mut()) {
        for h in hist.iter_mut() {
            if h.get("date").and_then(|d| d.as_str()) == Some(today.as_str()) {
                // 记录 ack 时刻的步数基线（供 Python 对比是否真的走了）
                h["user_acked_time"] = serde_json::Value::Number(now_ms.into());
                h["steps_at_ack"] = steps.clone();
                // 保存原始 last_move_time 供回滚用
                if h.get("last_move_time_before_ack").is_none() {
                    h["last_move_time_before_ack"] = h["last_move_time"].clone();
                }
                // 立刻重置（即时视觉反馈）
                h["last_move_time"] = serde_json::Value::String(now.clone());
                h["last_steps"] = steps.clone();
                h["sedentary_notified"] = serde_json::Value::Bool(false);
                h["follow_up"] = serde_json::Value::Bool(false);
                h["last_remind_time"] = serde_json::Value::Number(now_ms.into());
            }
        }
    }

    if let Some(t) = v.get_mut("today") {
        t["user_acked_time"] = serde_json::Value::Number(now_ms.into());
        t["steps_at_ack"] = steps.clone();
        // 保存原始值供回滚
        if t.get("last_move_time_before_ack").is_none() {
            t["last_move_time_before_ack"] = t["last_move_time"].clone();
        }
        // 立刻重置久坐数值
        t["last_move_time"] = serde_json::Value::String(now.clone());
        t["last_steps"] = steps.clone();
        t["sedentary"] = serde_json::Value::Bool(false);
        t["idle_min"] = serde_json::Value::Number(0.into());
        t["follow_up"] = serde_json::Value::Bool(false);
        t["last_remind_time"] = serde_json::Value::Number(now_ms.into());
    }

    std::fs::write(&data, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())
}

/// 用户点"稍后"：设置 snooze_until，让菜单栏弹窗与小组件弹窗共享同一份抑制状态。
#[tauri::command]
fn snooze_sedentary(app: AppHandle, minutes: u64) -> Result<(), String> {
    let (_, data, _, _) = paths(&app);
    let content = std::fs::read_to_string(&data).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let until = now_ms + (minutes as i64) * 60_000;
    let today = v["today"]["date"].as_str().unwrap_or("").to_string();

    if let Some(hist) = v.get_mut("history").and_then(|h| h.as_array_mut()) {
        for h in hist.iter_mut() {
            if h.get("date").and_then(|d| d.as_str()) == Some(today.as_str()) {
                h["snooze_until"] = serde_json::Value::Number(until.into());
            }
        }
    }
    if let Some(t) = v.get_mut("today") {
        t["snooze_until"] = serde_json::Value::Number(until.into());
    }
    std::fs::write(&data, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(app: AppHandle) -> String {
    serde_json::to_string(&load_settings(&app)).unwrap_or_else(|_| "{}".into())
}

#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let s: Settings = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    save_settings_file(&app, &s).map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<RefreshState>() {
        *state.0.lock().unwrap() = s.refresh_interval_min.max(1) * 60;
    }
    // 仅在用户摆放过位置时才复位：否则会把小组件甩回默认的 (20, 60)
    if s.pos_saved {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_position(tauri::LogicalPosition::new(s.pos_x as f64, s.pos_y as f64));
        }
    }
    set_autostart(s.autostart).map_err(|e| e.to_string())?;
    rebuild_tray_menu(&app);
    Ok(())
}

#[tauri::command]
fn set_autostart_cmd(enabled: bool) -> Result<(), String> {
    set_autostart(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_dnd_active_cmd() -> bool {
    is_dnd_active()
}

/// 久坐提醒通知文案池（与 Python 端 SEDENTARY_MSGS 风格一致，随机抽一条）
const SEDENTARY_NOTIFY_MSGS: [&str; 8] = [
    "已经静坐 {m} 分钟了，椅子都要长你身上了，起来晃晃？",
    "检测到人类已静止 {m} 分钟，本助理怀疑你被封印了，快解开！",
    "你的屁股和椅子已经谈了 {m} 分钟恋爱，该分手透透气了",
    "{m} 分钟没见你挪窝，血液都要罢工了，走两步呗",
    "静坐 {m} 分钟达成！奖励是更硬的腰和更僵的脖子，起来领罚？",
    "本健康监测员已记录你静坐 {m} 分钟，再不动我要去告状了",
    "检测到坐姿锁定 {m} 分钟，系统建议：站起来活动一下",
    "{m} 分钟稳如泰山，起来诈个尸吧",
];

/// 以本 app（Health Dashboard）身份弹 macOS 系统通知：久坐提醒
/// 前端在检测到 data.json 里 remind_event 变化时调用；勿扰模式由前端先判断。
#[tauri::command]
fn show_sedentary_notification(app: AppHandle, idle_min: i64) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let n = app.notification();
    // 首次会触发系统授权弹窗；已授权则直接发（拒绝则静默放弃，小组件仍在提醒）
    if let Ok(state) = n.permission_state() {
        if state != tauri_plugin_notification::PermissionState::Granted {
            let _ = n.request_permission();
        }
    }
    let idx = (chrono::Utc::now().timestamp_subsec_nanos() as usize) % SEDENTARY_NOTIFY_MSGS.len();
    let body = SEDENTARY_NOTIFY_MSGS[idx].replace("{m}", &idle_min.to_string());
    n.builder()
        .title("健康提醒")
        .body(body)
        .sound("Glass")
        .show()
        .map_err(|e| e.to_string())
}

/// 菜单栏图标下方的久坐提醒弹窗（与小组件内弹窗同款样式）。
/// 首次调用时创建 label="sed-pop" 的小窗（透明无装饰），后续复用只 show + 重定位。
/// 定位：以 Cocoa 取状态项窗口真实 frame（CG 坐标），水平居中、垂直贴图标下方 2px，
/// 全程在 CG 空间完成对齐与钳制，再换算到 Tauri 坐标，彻底规避 tray.rect() 多屏越界问题。

// 显示器信息：Tauri 坐标系（左上原点、Y 向下）矩形 (x,y,w,h)，
// 以及对应的 CG 坐标系（左下原点、Y 向上）原点 (cgx,cgy)，用于托盘/弹窗几何换算。
#[cfg(target_os = "macos")]
struct Disp {
    id: i32,
    name: String,
    is_primary: bool,
    x: f64, y: f64, w: f64, h: f64, // Tauri 矩形
    cgx: f64, cgy: f64,            // CG 原点（左下）
}

// 列出所有显示器，同时带 Tauri 矩形与 CG 原点，供 collect_displays 与弹窗定位共用。
#[cfg(target_os = "macos")]
fn displays_full() -> Vec<Disp> {
    unsafe {
        let screens: *mut Object = msg_send![class!(NSScreen), screens];
        let count: usize = msg_send![screens, count];

        // 先收集所有屏幕 frame，再找主屏。
        // 关键：不能用 NSScreen.mainScreen——本 app 是 Accessory 激活策略（不在 Dock），
        // 此时 mainScreen 会错误返回副屏（实测返回竖屏副屏而非真正主屏），导致 is_primary 标错、
        // 启动居中等依赖主屏的逻辑全部算到副屏。macOS 约定：主显示器左下角恒为全局 CG 原点 (0,0)，
        // 据此判断主屏最可靠。
        let mut items: Vec<(*mut Object, NSRect)> = Vec::new();
        for i in 0..count {
            let s: *mut Object = msg_send![screens, objectAtIndex: i];
            let f: NSRect = msg_send![s, frame];
            items.push((s, f));
        }
        let pf = items
            .iter()
            .map(|(_, f)| *f)
            .find(|f| f.origin.x.abs() < 0.5 && f.origin.y.abs() < 0.5)
            .unwrap_or(items[0].1);

        let mut arr = Vec::new();
        for (s, f) in items {
            let name: *mut Object = msg_send![s, localizedName];
            let name_str = if !name.is_null() {
                let cstr: *const c_char = msg_send![name, UTF8String];
                if !cstr.is_null() {
                    std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned()
                } else { "Display".to_string() }
            } else { "Display".to_string() };
            let hid: i32 = msg_send![s, hash];
            // Tauri y 由 CG（Y 向上）翻转得到，与 collect_displays 历史实现一致
            let ty = pf.origin.y + pf.size.height - (f.origin.y + f.size.height);
            let is_primary = f.origin.x.abs() < 0.5 && f.origin.y.abs() < 0.5;
            arr.push(Disp {
                id: hid,
                name: name_str,
                is_primary,
                x: f.origin.x,
                y: ty,
                w: f.size.width,
                h: f.size.height,
                cgx: f.origin.x,
                cgy: f.origin.y,
            });
        }
        arr
    }
}

// 取菜单栏状态项窗口的真实屏幕 frame（CG 坐标系，Y 向上）。
// 本 app 仅一个状态项，找 class 含 "StatusBar" 的顶层窗口即可。
#[cfg(target_os = "macos")]
fn status_bar_frame_cg() -> Option<(f64, f64, f64, f64)> {
    unsafe {
        let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() { return None; }
        let windows: *mut Object = msg_send![app, windows];
        let count: usize = msg_send![windows, count];
        for i in 0..count {
            let w: *mut Object = msg_send![windows, objectAtIndex: i];
            let cls: *mut Object = msg_send![w, className];
            if cls.is_null() { continue; }
            let cstr: *const c_char = msg_send![cls, UTF8String];
            if cstr.is_null() { continue; }
            let name = std::ffi::CStr::from_ptr(cstr).to_string_lossy();
            if name.contains("StatusBar") {
                let f: NSRect = msg_send![w, frame];
                return Some((f.origin.x, f.origin.y, f.size.width, f.size.height));
            }
        }
        None
    }
}

// 前端运行时错误回收：把 window.onerror / unhandledrejection / console.error
// 追加写入数据目录的 hd_fe_err.txt，便于排查"窗口空白"类渲染崩溃（沙箱无法读系统日志）。
#[tauri::command]
fn report_fe_error(app: AppHandle, msg: String) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("hd_fe_err.txt");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let ts = chrono::Local::now().format("%H:%M:%S").to_string();
            let _ = writeln!(f, "[{}] {}", ts, msg);
        }
    }
}

#[tauri::command]
fn show_sed_popover(app: AppHandle) -> Result<(), String> {
    const POP_W: f64 = 210.0;   // 186 卡片 + 左右余量（修复内容被裁）
    const POP_H: f64 = 102.0;   // 卡片 + 箭头 + 上下余量

    let mut target_pos = None;

    // 直接用 Cocoa 取状态项窗口真实 frame（CG 坐标，Y 向上），在 CG 空间完成对齐与钳制，
    // 再换算到 Tauri 坐标（Y 向下）。彻底绕开 tray.rect() 的 Physical/CG 语义歧义与多屏越界问题。
    #[cfg(target_os = "macos")]
    {
        if let Some((sx, sy, sw, sh)) = status_bar_frame_cg() {
            // 状态项中心（CG 坐标，Y 向上）
            let ccx = sx + sw / 2.0;
            let ccy = sy + sh / 2.0;
            // 找到状态项所在显示器（用 CG 原点判定包含关系）
            let disp = displays_full().into_iter().find(|d| {
                ccx >= d.cgx && ccx <= d.cgx + d.w && ccy >= d.cgy && ccy <= d.cgy + d.h
            });
            if let Some(d) = disp {
                // 弹窗水平居中对齐状态项中心；垂直贴在状态项底边下方 2px（CG 中"下"=y 更小）
                let pop_left_cg = ccx - POP_W / 2.0;
                let pop_bottom_cg = sy - 2.0; // 弹窗底边 = 状态项顶边 - 2px 缝隙
                // CG -> Tauri（Y 翻转，自显示器顶向下）
                let mut tx = pop_left_cg - d.cgx + d.x;
                let bottom_ty = d.y + d.h - (pop_bottom_cg - d.cgy);
                let mut ty = bottom_ty - POP_H;
                // 钳制进显示器内，杜绝越界/多屏错位
                tx = tx.max(d.x + 4.0).min(d.x + d.w - POP_W - 4.0);
                ty = ty.max(d.y + 4.0).min(d.y + d.h - POP_H - 4.0);
                let dbg = format!(
                    "[show_sed_popover] CG status=({:.0},{:.0})+{:.0}x{:.0} | Tauri popup=({:.1},{:.1}) disp=({:.0},{:.0})+{:.0}x{:.0} primary={}\n",
                    sx, sy, sw, sh, tx, ty, d.x, d.y, d.w, d.h, d.is_primary
                );
                // 调试日志写入应用数据目录（动态路径，不硬编码本机用户路径）
                if let Ok(dir) = app.path().app_data_dir() {
                    let _ = std::fs::write(dir.join("hd_popover_debug.txt"), &dbg);
                }
                eprintln!("[health] {}", dbg.trim());
                target_pos = Some((tx, ty));
            }
        }
    }

    // 兜底：拿不到状态项 frame（理论上不会发生），贴主屏菜单栏右侧。
    if target_pos.is_none() {
        #[cfg(target_os = "macos")]
        {
            let screens = displays_full();
            if let Some(primary) = screens.iter().find(|d| d.is_primary).or_else(|| screens.first()) {
                target_pos = Some((primary.x + primary.w - POP_W - 12.0, primary.y + 32.0));
                eprintln!("[health] status bar frame unavailable, fallback to primary menu bar right");
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            target_pos = Some((100.0, 100.0));
        }
    }

    let (x, y) = target_pos.ok_or("Could not determine popover position")?;
    eprintln!("[health] Final popover position: ({}, {})", x, y);

    if let Some(win) = app.get_webview_window("sed-pop") {
        let _ = win.close();
    }

    let win = tauri::WebviewWindowBuilder::new(
        &app,
        "sed-pop",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("久坐提醒")
    .inner_size(POP_W, POP_H)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .focused(true)
    .shadow(false)
    .build()
    .map_err(|e| e.to_string())?;
    
    #[cfg(target_os = "macos")]
    unsafe {
        if let Ok(ns) = win.ns_window() {
            let ns = ns as *mut objc::runtime::Object;
            let _: () = objc::msg_send![ns, orderFrontRegardless];
        }
    }

    Ok(())
}

/// 隐藏菜单栏久坐弹窗（前端按钮点击后调用）
#[tauri::command]
fn hide_sed_popover(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("sed-pop") {
        let _ = win.hide();
    }
    Ok(())
}

/// 立即更新采集间隔（前端不用保存就生效）
#[tauri::command]
fn update_refresh_interval(app: AppHandle, seconds: u64) -> Result<(), String> {
    let secs = seconds.max(1);
    if let Some(state) = app.try_state::<RefreshState>() {
        *state.0.lock().unwrap() = secs;
    }
    // 前端预设点击：同步设置 + 菜单勾选（无保存即生效）
    let mins = (secs / 60).max(1);
    let sh = app.state::<SettingsHandle>();
    sh.set("refresh_interval_min", mins);
    let s = sh.clone_inner();
    save_settings_file(&app, &s).map_err(|e| e.to_string())?;
    rebuild_tray_menu(&app);
    eprintln!("[health] refresh_interval updated to {}s", secs);
    Ok(())
}

/// 切换开机自启（立即写文件）
#[tauri::command]
fn toggle_autostart_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let sh = app.state::<SettingsHandle>();
    sh.set("autostart", enabled);
    let s = sh.clone_inner();
    save_settings_file(&app, &s).map_err(|e| e.to_string())?;
    set_autostart(enabled).map_err(|e| e.to_string())?;
    eprintln!("[health] autostart set to {}", enabled);
    rebuild_tray_menu(&app);
    Ok(())
}

/// 在默认浏览器中打开外部设置引导页（Google 授权 / AI 配置等）
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/c", "start", "", &url]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 打开本地设置向导网页：起 127.0.0.1:18911 服务 + 浏览器打开。
/// 之前 app 内按钮直接 openExternal 到 GitHub README，用户点了根本看不到配置页——
/// 真正的配置页是这个本地服务提供的 setup.html，必须走这里。
#[tauri::command]
fn open_setup_wizard_cmd(app: AppHandle) -> Result<(), String> {
    ensure_setup_server(app.clone());
    open_external(format!("http://127.0.0.1:{}/setup", SETUP_SERVER_PORT))
}

// ── 设置向导：本地 HTTP 服务（浏览器填写并保存，回写 App）────────────────────
const SETUP_SERVER_PORT: u16 = 18911;
static SETUP_SERVER_STARTED: OnceLock<()> = OnceLock::new();

/// 确保本地向导服务只启动一次（绑定 127.0.0.1:18911），随后打开浏览器
fn ensure_setup_server(app: AppHandle) {
    SETUP_SERVER_STARTED.get_or_init(|| {
        std::thread::spawn(move || {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", SETUP_SERVER_PORT)) {
                eprintln!("[health] setup server listening on :{}", SETUP_SERVER_PORT);
                for stream in listener.incoming() {
                    if let Ok(s) = stream {
                        let app2 = app.clone();
                        std::thread::spawn(move || { let _ = handle_setup_conn(s, &app2); });
                    }
                }
            } else {
                eprintln!("[health] setup server bind failed (port {} in use?)", SETUP_SERVER_PORT);
            }
        });
        // 等端口就绪（最多 ~1s），避免浏览器抢先连接被拒
        for _ in 0..50 {
            if TcpStream::connect(("127.0.0.1", SETUP_SERVER_PORT)).is_ok() { break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    });
}

/// 处理单个 HTTP 连接：GET /setup 返回向导页，POST /api/save 回写设置，GET /api/load 预填
fn handle_setup_conn(mut stream: TcpStream, app: &AppHandle) {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    let mut reader = match stream.try_clone() {
        Ok(r) => BufReader::new(r),
        Err(_) => return,
    };
    let mut request_line = String::new();
    let n = match reader.read_line(&mut request_line) { Ok(n) => n, Err(_) => return };
    if n == 0 { return; }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 { return; }
    let method = parts[0];
    let path = parts[1];

    let mut content_length = 0usize;
    loop {
        let mut h = String::new();
        let hn = match reader.read_line(&mut h) { Ok(n) => n, Err(_) => break };
        if hn == 0 { break; }
        if h == "\r\n" { break; }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        if reader.read_exact(&mut body).is_err() { body.clear(); }
    }

    if method == "POST" && path.starts_with("/api/save") {
        let resp = setup_save(&body, app);
        send_http(&mut stream, 200, "application/json; charset=utf-8", resp.as_bytes());
    } else if method == "GET" && path.starts_with("/api/load") {
        let s = load_settings(app);
        let out = serde_json::json!({
            "google_client_id": s.google_client_id,
            "google_client_secret": s.google_client_secret,
            "llm_base_url": s.llm_base_url,
            "llm_api_key": s.llm_api_key,
            "llm_model": s.llm_model,
        });
        let j = serde_json::to_string(&out).unwrap_or_else(|_| " {}".to_string());
        send_http(&mut stream, 200, "application/json; charset=utf-8", j.as_bytes());
    } else if method == "POST" && path.starts_with("/api/test-llm") {
        // 延迟测试：优先用页面当前输入的值（未保存也能测），缺失时回落到已保存设置
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::json!({}));
        let s = load_settings(app);
        let base_url = v.get("base_url").and_then(|x| x.as_str())
            .filter(|x| !x.trim().is_empty()).unwrap_or(&s.llm_base_url).to_string();
        let api_key = v.get("api_key").and_then(|x| x.as_str())
            .filter(|x| !x.trim().is_empty()).unwrap_or(&s.llm_api_key).to_string();
        let model = v.get("model").and_then(|x| x.as_str())
            .filter(|x| !x.trim().is_empty()).unwrap_or(&s.llm_model).to_string();
        let resp = llm_api_ping_blocking(&base_url, &api_key, &model);
        send_http(&mut stream, 200, "application/json; charset=utf-8", resp.as_bytes());
    } else if method == "POST" && path.starts_with("/api/test-data") {
        let resp = match data_api_ping_blocking(app) {
            Ok(j) => j,
            Err(e) => serde_json::json!({"ok": false, "ms": 0, "detail": e}).to_string(),
        };
        send_http(&mut stream, 200, "application/json; charset=utf-8", resp.as_bytes());
    } else if path.starts_with("/setup") || path == "/" || path.starts_with("/index") {
        let html = load_setup_html(app);
        send_http(&mut stream, 200, "text/html; charset=utf-8", html.as_bytes());
    } else {
        send_http(&mut stream, 404, "text/plain; charset=utf-8", b"Not Found");
    }
}

/// 回写设置：settings.json（llm/google 字段）+ ~/.google-health-mcp/config.json（合并保留 token）
fn setup_save(body: &[u8], app: &AppHandle) -> String {
    let val: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({"ok": false, "error": e.to_string()}).to_string(),
    };

    // 1) settings.json
    let mut s = load_settings(app);
    if let Some(v) = val.get("llm_base_url").and_then(|x| x.as_str()) { s.llm_base_url = v.to_string(); }
    if let Some(v) = val.get("llm_api_key").and_then(|x| x.as_str()) { s.llm_api_key = v.to_string(); }
    if let Some(v) = val.get("llm_model").and_then(|x| x.as_str()) { s.llm_model = v.to_string(); }
    if let Some(v) = val.get("google_client_id").and_then(|x| x.as_str()) { s.google_client_id = v.to_string(); }
    if let Some(v) = val.get("google_client_secret").and_then(|x| x.as_str()) { s.google_client_secret = v.to_string(); }
    if let Some(v) = val.get("app_name").and_then(|x| x.as_str()) { s.app_name = v.to_string(); }
    if let Some(v) = val.get("custom_icon").and_then(|x| x.as_str()) { s.custom_icon = v.to_string(); }
    if let Some(v) = val.get("dnd_follow").and_then(|x| x.as_bool()) { s.dnd_follow = v; }
    let _ = save_settings_file(app, &s);

    // 1b) 应用自定义图标到菜单栏（若有）
    apply_tray_icon(app, &s);

    // 2) ~/.google-health-mcp/config.json（合并，不破坏已有 token）
    let home = match app.path().home_dir() {
        Ok(h) => h,
        Err(_) => return serde_json::json!({"ok": false, "error": "home_dir missing"}).to_string(),
    };
    let cfg_path = home.join(".google-health-mcp").join("config.json");
    let mut cfg: serde_json::Value = if cfg_path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap_or_else(|_| " {}".to_string()))
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if let Some(v) = val.get("google_client_id").and_then(|x| x.as_str()) {
        cfg["GOOGLE_HEALTH_CLIENT_ID"] = serde_json::Value::String(v.to_string());
    }
    if let Some(v) = val.get("google_client_secret").and_then(|x| x.as_str()) {
        cfg["GOOGLE_HEALTH_CLIENT_SECRET"] = serde_json::Value::String(v.to_string());
    }
    if let Some(parent) = cfg_path.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = std::fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap_or_default());

    // 3) 同步内存状态 + 广播前端
    if let Some(sh) = app.try_state::<SettingsHandle>() {
        *sh.0.lock().unwrap() = s.clone();
    }
    if let Ok(json) = serde_json::to_string(&s) {
        let _ = app.emit("settings-changed", json);
    }

    serde_json::json!({"ok": true}).to_string()
}

fn load_setup_html(app: &AppHandle) -> String {
    if let Ok(rd) = app.path().resource_dir() {
        let p = rd.join("resources").join("setup.html");
        if let Ok(s) = std::fs::read_to_string(&p) { return s; }
    }
    "<!doctype html><meta charset=utf-8><body style='font-family:sans-serif;padding:24px'>\n<h2>setup.html 未找到</h2><p>请确认已打包 resources/setup.html。</p></body>".to_string()
}

fn send_http(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {} OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        status, content_type, body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}

#[tauri::command]
fn get_appearance() -> String {
    if current_appearance_dark() {
        "dark".into()
    } else {
        "light".into()
    }
}

/// 列出显示器（Tauri 坐标系：左上原点，y 向下）。用于「指定显示器定位」。
/// 直接由 displays_full() 映射而来，保持对外 JSON 结构不变（id=hash，isPrimary 等）。
#[cfg(target_os = "macos")]
fn collect_displays() -> Vec<serde_json::Value> {
    displays_full()
        .iter()
        .map(|d| {
            serde_json::json!({
                "id": d.id,
                "name": d.name,
                "x": d.x as i32,
                "y": d.y as i32,
                "width": d.w as i32,
                "height": d.h as i32,
                "isPrimary": d.is_primary,
            })
        })
        .collect()
}
#[cfg(not(target_os = "macos"))]
fn collect_displays() -> Vec<serde_json::Value> { vec![] }

#[tauri::command]
fn list_displays() -> String {
    serde_json::to_string(&collect_displays()).unwrap_or_else(|_| "[]".into())
}

/// 移动窗口到绝对坐标 (x, y)。Tauri 坐标系：左上原点，y 向下。
/// display_id 仅用于记录当前所在显示器，不再参与坐标换算（杜绝副屏错位 / 越移越歪）。
#[tauri::command]
fn set_position(app: AppHandle, _display_id: i32, x: i32, y: i32) -> Result<String, String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    Ok(format!("moved to absolute ({},{})", x, y))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复启动：不创建新实例，把已有主窗口带回桌面并聚焦
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        // 久坐提醒：以本 app 身份发系统通知（通知中心显示来源为 Health Dashboard）
        .plugin(tauri_plugin_notification::init())
        // liquid_glass 插件已弃用（见 import 注释）
        .setup(|app| {
            // macOS：强制 Accessory 激活策略（不在 Dock 显示、不抢菜单栏/焦点）
            #[cfg(target_os = "macos")]
            {
                let _ = app
                    .handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory);
                let _ = APP_HANDLE.set(app.handle().clone());

                // 系统勿扰（Focus）实时同步：监听 Control Center 的分布式通知广播
                start_dnd_observer(app.handle().clone());

                // 清空默认 App 菜单（File/Edit/View...），只保留状态栏图标
                use tauri::menu::Menu;
                if let Ok(empty) = Menu::with_items(app.handle(), &[]) {
                    let _ = app.set_menu(empty);
                }
            }

            // 读取设置并应用
            let settings = load_settings(app.handle());
            let refresh_secs = Arc::new(Mutex::new(settings.refresh_interval_min.max(1) * 60));
            app.manage(RefreshState(refresh_secs.clone()));
            app.manage(SettingsHandle(Arc::new(Mutex::new(settings.clone()))));
            #[cfg(target_os = "macos")]
            app.manage(MenuItemsState(std::sync::Mutex::new(None)));
            #[cfg(target_os = "macos")]
            app.manage(GlassViewState(std::sync::Mutex::new(None)));

            // macOS：桌面小组件窗口
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                use cocoa::foundation::NSRect;
                use objc::{class, msg_send, sel, sel_impl};
                use objc::runtime::{Object, YES as YES_BOOL};
                unsafe {
                    let ns = win.ns_window().expect("ns_window") as *mut Object;
                    // kCGDesktopIconWindowLevel(-2147483603) + 1
                    let _: () = msg_send![ns, setLevel: -2147483602i64];
                    // CanJoinAllSpaces(1) | Stationary(16)
                    let _: () = msg_send![ns, setCollectionBehavior: 17u64];
                    let _: () = msg_send![ns, setHasShadow: false];
                    let _: () = msg_send![ns, setOpaque: false];
                    let color: *mut Object = msg_send![objc::class!(NSColor), clearColor];
                    let _: () = msg_send![ns, setBackgroundColor: color];
                    let _: () = msg_send![ns, setMovableByWindowBackground: false];
                    let content_view: *mut Object = msg_send![ns, contentView];
                    let _: () = msg_send![content_view, setWantsLayer: true];
                    let style: u64 = msg_send![ns, styleMask];
                    let _: () = msg_send![ns, setStyleMask: style | 128u64];

                    // contentView 的实际尺寸（WKWebView 在 transparent 模式下 bounds 可能为 0，故取 contentView）
                    let frame: NSRect = msg_send![content_view, frame];

                    // ── 背景玻璃：macOS 26+ 用真·液态玻璃 NSGlassEffectView，旧系统回退 NSVisualEffectView ──
                    let glass_cls: Option<&objc::runtime::Class> =
                        objc::runtime::Class::get("NSGlassEffectView");
                    let mut used_glass = false;
                    if let (Some(gcls), Ok(wv_ptr)) = (glass_cls, win.ns_view()) {
// macOS 26+ 真·液态玻璃：把整个 webview 作为 contentView 嵌进玻璃，
                    // 由系统负责折射/高光/边缘镜面，并按 cornerRadius 裁剪内容。
                    // 0 = Regular（标准液态玻璃，高光与折射明显）
                    // 1 = Clear（清玻璃，更通透、高光更弱）
                    let _wv = wv_ptr as *mut Object; // 仅校验 webview 句柄可用，不移动它
                    let glass: *mut Object = msg_send![gcls, alloc];
                    let glass: *mut Object = msg_send![glass, initWithFrame: frame];
                    // 0 = Regular（标准液态玻璃，高光/折射明显，但浅色外观下底偏白）
                    // 1 = Clear（清玻璃，更通透、底更薄）—— 浅色外观下用 Clear 避免"白底"
                    let _: () = msg_send![glass, setStyle: 1i64];
                    // 圆角按当前主题决定：液态玻璃 36 / 像素动漫风 0（实底硬边方角）
                    let initial_radius: f64 = style_corner_radius(&settings.style);
                    let _: () = msg_send![glass, setCornerRadius: initial_radius];
                        let _: () = msg_send![glass, setAutoresizingMask: 18u64];
                        // 液态玻璃默认带阴影来表现层次，但阴影轮廓是**矩形**（cornerRadius 只裁剪
                        // 玻璃本身的绘制，不改变 shadow 形状）→ 四角会露出方形投影。用户明确不要阴影，关掉。
                        let _: () = msg_send![glass, setWantsLayer: YES_BOOL];
                        let glass_layer: *mut Object = msg_send![glass, layer];
                        let _: () = msg_send![glass_layer, setShadowOpacity: 0.0f32];
                        // 只作背景层插入（与原 NSVisualEffectView 完全相同的挂载方式）。
                        // 不把 webview 嵌进 contentView —— 那种用法在 desktop-level 透明窗口
                        // 上会触发 AppKit 无限合成递归（实测 addSubview 直接爆栈）。
                        // 玻璃在底层提供模糊/高光/折射，webview 透明叠在其上显示内容。
                        let null_obj: *mut Object = std::ptr::null_mut();
                        let _: () = msg_send![content_view, addSubview: glass positioned: -1i64 relativeTo: null_obj];
                        used_glass = true;
                        // 保存玻璃视图指针到 GlassViewState（切主题时改圆角）
                        if let Some(g) = app.try_state::<GlassViewState>() {
                            *g.inner().0.lock().unwrap() = Some(glass as *mut objc::runtime::Object);
                        }
                    }
                    if !used_glass {
                    // 系统原生磨砂玻璃：直接用 objc 建 NSVisualEffectView（绕过 window-vibrancy crate）
                    // 原因 1：window-vibrancy 用 view.bounds() 创建，WKWebView 在 transparent 模式下初始为 0，
                    //         vibrancy view 不自动撑大，露出下方 ~50px 灰色带（用户截图反馈"底部阴影"）
                    // 原因 2：state 设 Active，点击小组件触发窗口激活后整个 vibrancy 变深（用户反馈"点击变黑"）
                    // 解决：手动拿 contentView.frame 建 vibrancy view；state 锁定 Inactive 让小组件视觉稳定
                    // NSVisualEffectView
                    let cls = class!(NSVisualEffectView);
                    let vibrancy: *mut Object = msg_send![cls, alloc];
                    let vibrancy: *mut Object = msg_send![vibrancy, initWithFrame: frame];
                    // Popover material (6)：浅色外观下是半透明磨砂玻璃（最接近液态玻璃观感）。
                    // 注意 10 是 WindowBackground（近不透明白板/深板，模糊极弱，之前"白底无玻璃感"根因），
                    // 真正的 HUDWindow 是 11（但恒为深色调，浅色主题下突兀），故用 Popover。
                    let _: () = msg_send![vibrancy, setMaterial: 6i64];
                    // BehindWindow blending mode (0)
                    let _: () = msg_send![vibrancy, setBlendingMode: 0i64];
                    // Inactive state (1) — 锁定浅色，窗口激活不切换
                    let _: () = msg_send![vibrancy, setState: 1i64];
                    let initial_radius2: f64 = style_corner_radius(&settings.style);
                    let _: () = msg_send![vibrancy, setCornerRadius: initial_radius2];
                    // WantsLayer
                    let _: () = msg_send![vibrancy, setWantsLayer: YES_BOOL];
                    // autoresizing: width+height sizable (18 = 2|16)
                    let _: () = msg_send![vibrancy, setAutoresizingMask: 18u64];
                    // 加到 contentView 下方（NSWindowBelow = -1）
                    let null_obj2: *mut Object = std::ptr::null_mut();
                    let _: () = msg_send![content_view, addSubview: vibrancy positioned: -1i64 relativeTo: null_obj2];
                    // 同样把旧版 NSVisualEffectView 指针存到 GlassViewState，切主题时改圆角
                    if let Some(g) = app.try_state::<GlassViewState>() {
                        *g.inner().0.lock().unwrap() = Some(vibrancy as *mut objc::runtime::Object);
                    }
                    }
                }
                // vibrancy 挂载后再清理一次窗口阴影
                disable_window_shadow(&win);
            }

            // Windows：Acrylic 磨砂 + 常驻桌面（Windows 没有 NSWindow 桌面层级 API，
            // 用 always_on_bottom 模拟"贴桌面"效果）
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window("main") {
                use window_vibrancy::apply_acrylic;
                // Acrylic 效果：Win10 1803+ / Win11，rgba 为窗口基色（带透明度）
                // 失败（如远程桌面/旧系统）则前端 CSS 半透明背景兜底
                let _ = apply_acrylic(&win, Some((18, 18, 20, 125)));
                // 贴桌面：始终置底
                let _ = win.set_always_on_bottom(true);
                // 显式透明背景，让 Acrylic 透出
                let _ = win.set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)));
            }

            // 启动定位：用户摆放过就恢复上次位置；从未摆放过才主屏居中（首次启动方便一眼找到）
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    let s = load_settings(app.handle());
                    if s.pos_saved {
                        // pos_x/pos_y 统一为逻辑点：与 Moved 事件（物理像素）经 scale 换算后一致
                        let (cx, cy) = clamp_to_screens(s.pos_x, s.pos_y, &collect_displays(), 344, 272);
                        let _ = win.set_position(tauri::LogicalPosition::new(cx as f64, cy as f64));
                        eprintln!("[health] 启动定位：恢复上次位置 ({}, {})", cx, cy);
                    } else {
                        let center = displays_full()
                            .into_iter()
                            .find(|d| d.is_primary)
                            .or_else(|| displays_full().into_iter().next());
                        if let Some(d) = center {
                            let cx = d.x + (d.w - 344.0) / 2.0;
                            let cy = d.y + (d.h - 272.0) / 2.0;
                            let _ = win.set_position(tauri::LogicalPosition::new(cx, cy));
                            eprintln!("[health] 启动定位：首次启动，主屏居中 ({:.0}, {:.0})", cx, cy);
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    if let Ok(Some(monitor)) = win.primary_monitor() {
                        let pos = monitor.position();
                        let size = monitor.size();
                        let scale = win.scale_factor().unwrap_or(1.0);
                        let cx = pos.x as f64 / scale + (size.width as f64 / scale - 344.0) / 2.0;
                        let cy = pos.y as f64 / scale + (size.height as f64 / scale - 272.0) / 2.0;
                        let _ = win.set_position(tauri::LogicalPosition::new(cx, cy));
                    }
                }

                // 拖拽移动后保存新位置（debounce 600ms，避免拖拽中频繁写盘；clamp 防止移出屏幕）
                let app_handle = app.handle().clone();
                let last_save: Arc<Mutex<std::time::Instant>> =
                    Arc::new(Mutex::new(std::time::Instant::now()));
                let _ = win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(pos) = event {
                        let mut last = last_save.lock().unwrap();
                        if last.elapsed().as_millis() < 600 {
                            return;
                        }
                        *last = std::time::Instant::now();
                        // Moved 事件给的是物理像素，统一换算成逻辑点再存（Retina 上 scale=2，
                        // 否则每次重启位置都会被 scale 除一次，越跑越偏）
                        let scale = app_handle
                            .get_webview_window("main")
                            .and_then(|w| w.scale_factor().ok())
                            .unwrap_or(1.0)
                            .max(0.1);
                        let lx = (pos.x as f64 / scale).round() as i32;
                        let ly = (pos.y as f64 / scale).round() as i32;
                        let sh = app_handle.state::<SettingsHandle>();
                        let (cx, cy) = clamp_to_screens(lx, ly, &collect_displays(), 344, 272);
                        sh.set("pos_saved", true);
                        sh.set("pos_x", cx);
                        sh.set("pos_y", cy);
                        let _ = save_settings_file(&app_handle, &sh.clone_inner());
                        eprintln!("[health] 保存窗口位置（逻辑点）: ({}, {})", cx, cy);
                    }
                });
            }

            // 菜单栏/系统托盘图标 + Clash 风格点击弹窗（macOS 菜单栏 / Windows 系统托盘）
            {
                // [DEPRECATED] NSStatusBar 菜单栏图标已移除，改用下方的 Tauri TrayIcon API
                // ── Tauri TrayIcon：精准捕获菜单栏图标点击 ──────────────
                use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState};
                use tauri::image::Image;

                // 从 icons/ 目录加载菜单栏图标（支持自定义图标：预设/上传优先，否则默认）
                let resource_dir = app.path().resource_dir().unwrap_or_default();
                eprintln!("[health] resource_dir: {:?}", resource_dir);

                let icon = resolve_icon_image(app.handle(), &settings).unwrap_or_else(|| {
                    let icon_path = resource_dir.join("icons/tray_white.png");
                    eprintln!("[health] icon_path: {:?}", icon_path);
                    Image::from_path(&icon_path).unwrap_or_else(|e| {
                        eprintln!("[health] icon load failed: {:?}", e);
                        Image::new_owned(vec![0u8; 4], 1, 1)
                    })
                });

                let app_handle = app.handle().clone();
                let tray_app = app.handle().clone(); // separate clone for closure
                let _tray = TrayIconBuilder::with_id("main")
                    .icon(icon)
                    .tooltip(app_title(&settings))
                    .on_tray_icon_event(move |_tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event {
                            eprintln!("[health] tray left-click!");
                            let _ = tray_app.emit("toggle-settings", ());
                        }
                    })
                    .on_menu_event(|app, event| {
                        let id = event.id().as_ref();
                        eprintln!("[health] tray menu event: {}", id);
                        let sh = app.state::<SettingsHandle>();
                        let items_state = app.state::<MenuItemsState>();
                        let mut s_changed = false;

                        // 互斥组单选修正（set_checked，确定性，不依赖重建时序）
                        let radio = |group: &str, on: &str| {
                            if let Some(ref it) = *items_state.0.lock().unwrap() {
                                menu_radio(group, on, it);
                            }
                        };

                        match id {
                            "quit" => app.exit(0),
                            "restart" => relaunch(app),
                            "refresh_now" => { let _ = app.emit("refresh-now", ()); }
                            "open_setup" => {
                                ensure_setup_server(app.clone());
                                let _ = open_external(format!("http://127.0.0.1:{}/setup", SETUP_SERVER_PORT));
                            }
                            "open_data_folder" => {
                                let dir = app.path().app_data_dir().unwrap_or_default();
                                #[cfg(target_os = "macos")]
                                let _ = std::process::Command::new("open").arg(&dir).spawn();
                                #[cfg(target_os = "windows")]
                                let _ = std::process::Command::new("explorer").arg(&dir).spawn();
                                #[cfg(target_os = "linux")]
                                let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
                            }
                            // ── 主题 ──
                            "theme_auto"  => { radio("theme", "theme_auto");  sh.set("theme", "auto");  s_changed = true; }
                            "theme_light" => { radio("theme", "theme_light"); sh.set("theme", "light"); s_changed = true; }
                            "theme_dark"  => { radio("theme", "theme_dark");  sh.set("theme", "dark");  s_changed = true; }
                            // ── 主题（仅换皮肤：液态玻璃 / 像素动漫风）──
                            "style_liquid" => { radio("style", "style_liquid"); sh.set("style", "liquid-glass"); apply_window_style(app, "liquid-glass"); s_changed = true; }
                            "style_pixel"  => { radio("style", "style_pixel");  sh.set("style", "pixel-anime");  apply_window_style(app, "pixel-anime");  s_changed = true; }
                            "style_brutal" => { radio("style", "style_brutal"); sh.set("style", "brutalist-web"); apply_window_style(app, "brutalist-web"); s_changed = true; }
                            "style_term"   => { radio("style", "style_term");   sh.set("style", "developer-terminal"); apply_window_style(app, "developer-terminal"); s_changed = true; }
                            // ── 语言 ──
                            "lang_zh" => { radio("lang", "lang_zh"); sh.set("language", "zh-CN"); s_changed = true; }
                            "lang_en" => { radio("lang", "lang_en"); sh.set("language", "en");    s_changed = true; }
                            "lang_ja" => { radio("lang", "lang_ja"); sh.set("language", "ja");    s_changed = true; }
                            // ── 刷新间隔 ──
                            "refresh_5"  => { radio("refresh", "refresh_5");  sh.set("refresh_interval_min", 5u64);  s_changed = true; }
                            "refresh_15" => { radio("refresh", "refresh_15"); sh.set("refresh_interval_min", 15u64); s_changed = true; }
                            "refresh_30" => { radio("refresh", "refresh_30"); sh.set("refresh_interval_min", 30u64); s_changed = true; }
                            // ── 久坐阈值 / 提醒间隔 ──
                            "sed_30"  => { radio("sed", "sed_30");  sh.set("sedentary_min", 30u64); s_changed = true; }
                            "sed_40"  => { radio("sed", "sed_40");  sh.set("sedentary_min", 40u64); s_changed = true; }
                            "sed_45"  => { radio("sed", "sed_45");  sh.set("sedentary_min", 45u64); s_changed = true; }
                            "sed_60"  => { radio("sed", "sed_60");  sh.set("sedentary_min", 60u64); s_changed = true; }
                            "sed_90"  => { radio("sed", "sed_90");  sh.set("sedentary_min", 90u64); s_changed = true; }
                            // ── 桌搭伙伴 ──
                            "char_qiuqiu"  => { radio("char", "char_qiuqiu");  sh.set("character", "qiuqiu");  s_changed = true; }
                            "char_nimbo"   => { radio("char", "char_nimbo");   sh.set("character", "nimbo");   s_changed = true; }
                            "char_twinkle" => { radio("char", "char_twinkle"); sh.set("character", "twinkle"); s_changed = true; }
                            "char_claw"    => { radio("char", "char_claw");    sh.set("character", "claw");    s_changed = true; }
                            "char_random"  => { radio("char", "char_random");  sh.set("character", "random");  s_changed = true; }
                            // ── 布尔 toggle ──
                            "toggle_autostart" => {
                                let cur = sh.0.lock().unwrap().autostart;
                                sh.set("autostart", !cur); s_changed = true;
                                if let Some(ref it) = *items_state.0.lock().unwrap() { let _ = it.autostart.set_checked(!cur); }
                            }
                            // 勿扰不再提供开关：始终跟随系统专注模式（menu_strings 里已移除该项）
                            // ── 显示/隐藏小组件 ──
                            "toggle_visible" => {
                                let cur = sh.0.lock().unwrap().widget_visible;
                                sh.set("widget_visible", !cur); s_changed = true;
                                if let Some(ref it) = *items_state.0.lock().unwrap() { let _ = it.visible.set_checked(!cur); }
                            }
                            _ => {}
                        }

                        if s_changed {
                            let new_s = sh.clone_inner();
                            if let Ok(json) = serde_json::to_string(&new_s) {
                                let _ = save_settings_file(app, &new_s);
                                let _ = app.emit("settings-changed", json);
                                let secs = new_s.refresh_interval_min.max(1) * 60;
                                *app.state::<RefreshState>().0.lock().unwrap() = secs;
                            }
                            // 仅 widget_visible/display 变化时才同步窗口显隐与位置，
                            // 其他设置变化（久坐/刷新间隔/主题/语言/勿扰等）不需要重定位，
                            // 否则每次菜单操作都会 set_position 导致窗口跳动
                            if id == "toggle_visible" || id.starts_with("display_") {
                                sync_main_widget(app, &new_s);
                            }
                            // 总是重建菜单：保证 macOS 菜单勾选态与设置一致（消除多选视觉残留）
                            rebuild_tray_menu(app);
                        }
                    })
                    .menu(&build_main_menu(&app_handle, &load_settings(&app_handle)))
                    .show_menu_on_left_click(true)
                    .build(&app_handle)?;

                eprintln!("[health] TrayIcon built OK");
            }

            // 外观监控线程：检测系统明暗变化，变化时广播 appearance-changed
            let handle = app.handle().clone();
            let init_dark = current_appearance_dark();
            let _ = handle.emit("appearance-changed", if init_dark { "dark" } else { "light" });
            std::thread::spawn(move || {
                let mut last: Option<bool> = Some(init_dark);
                loop {
                    let dark = current_appearance_dark();
                    let changed = last.map_or(true, |l| l != dark);
                    if changed {
                        last = Some(dark);
                        let _ = handle.emit("appearance-changed", if dark { "dark" } else { "light" });
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            });

            // 常驻采集线程（间隔来自 settings，可被 save_settings 热更新）
            let setup_handle = app.handle().clone();
            let handle = setup_handle.clone();
            std::thread::spawn(move || loop {
                let (py, data, tok, cfg) = paths(&handle);
                // 久坐阈值/提醒间隔每次采集前读最新设置，改设置立即生效
                let (sed_min, remind_min) = {
                    let sh = handle.state::<SettingsHandle>();
                    let g = sh.0.lock().unwrap();
                    (g.sedentary_min, g.sedentary_remind_min)
                };
                let _ = run_fetch_once(&py, &data, &tok, &cfg, sed_min, remind_min);
                let secs = {
                    let state = handle.try_state::<RefreshState>();
                    match state {
                        Some(s) => *s.0.lock().unwrap(),
                        None => 300,
                    }
                };
                std::thread::sleep(Duration::from_secs(secs));
            });

            // 应用自启设置
            let _ = set_autostart(settings.autostart);

            // 启动即常驻本地向导服务（仅监听 127.0.0.1）：
            // 之前是点「设置向导」才临时起，首次点击要等服务就绪，且外部无法预检。
            // 常驻后：网页内两个延迟测试随时可用，点击也无需等待。
            ensure_setup_server(setup_handle.clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_data,
            refresh_now,
            ai_chat,
            test_data_api,
            open_setup_wizard_cmd,
            reset_sedentary,
            snooze_sedentary,
            get_settings,
            save_settings,
            set_autostart_cmd,
            is_dnd_active_cmd,
            show_sedentary_notification,
            show_sed_popover,
            hide_sed_popover,
            get_appearance,
            list_displays,
            set_position,
            update_refresh_interval,
            toggle_autostart_setting,
            open_external,
            report_fe_error,
            set_app_identity,
            reset_app_identity,
            get_app_identity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
