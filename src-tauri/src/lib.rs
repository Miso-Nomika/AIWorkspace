mod agent;
mod chat;
mod cleanup;
mod data;
mod home;
mod home_fetch;
mod memory;
mod music;
mod options;
mod remote;
mod session;
mod sheet;
mod terminal;
mod tray;
mod watch;
mod workspace;

use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

/// 자동 시작으로 켜졌다는 표시 (이 인자가 있으면 창을 숨긴 채 트레이로만 시작한다)
const HIDDEN_ARG: &str = "--hidden";

/// 컴퓨터를 켤 때 자동 실행 등록/해제 (Windows 시작 프로그램·Linux autostart). 이미 원하는 상태면 아무것도 하지 않는다.
fn apply_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
  let manager = app.autolaunch();
  let on = manager.is_enabled().map_err(|e| e.to_string())?;
  match (enabled, on) {
    (true, false) => manager.enable().map_err(|e| e.to_string()),
    (false, true) => manager.disable().map_err(|e| e.to_string()),
    _ => Ok(()),
  }
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
  apply_autostart(&app, enabled)
}

/// 설치 방식: 자동 업데이트가 가능한지 판단하는 용도.
/// "appimage"(Linux AppImage) · "windows"(설치 프로그램) · "package"(Linux .deb 등 — 앱이 스스로 교체할 수 없음) · "test"(점검용 실행 — 업데이트 서버를 부르지 않음)
#[tauri::command]
fn install_kind() -> &'static str {
  if data::external_blocked() {
    "test"
  } else if cfg!(windows) {
    "windows"
  } else if std::env::var_os("APPIMAGE").is_some_and(|v| !v.is_empty()) {
    "appimage"
  } else {
    "package"
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();
  // 두 번째로 실행하면 새 창 대신 이미 떠 있는(숨겨졌을 수도 있는) 창을 앞으로 가져온다.
  // (점검용 실행처럼 데이터 폴더를 따로 지정한 경우는 서로 독립이므로 제외한다. 다른 플러그인보다 먼저 등록해야 한다.)
  if std::env::var_os("AIWORKSPACE_DATA_DIR").is_none() {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main_window(app)));
  }
  // 자동 시작 등록 이름: 점검용 실행(데이터 폴더를 따로 지정)은 실제 설치본의 등록을 건드리지 않게 다른 이름을 쓴다
  let mut autostart = tauri_plugin_autostart::Builder::new().args([HIDDEN_ARG]);
  if std::env::var_os("AIWORKSPACE_DATA_DIR").is_some() {
    autostart = autostart.app_name("AIWorkspace-test");
  }
  builder
    .plugin(autostart.build())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(agent::AgentRuns::default())
    .manage(chat::ChatRuns::default())
    .manage(watch::Watching::default())
    .manage(remote::Remote::default())
    .manage(tray::TrayState::default())
    .manage(terminal::TerminalState::default())
    // 옵션이 켜져 있고 트레이가 있을 때만 창 닫기를 가로채 숨긴다 (진짜 종료: 트레이 "종료", 자동 업데이트 재시작은 영향 없음)
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        if window.label() == tray::MAIN_WINDOW && app.state::<tray::TrayState>().available() && options::close_to_tray(app) {
          api.prevent_close();
          let _ = window.hide();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      install_kind,
      set_autostart,
      data::data_load_all,
      data::data_save,
      data::data_remove,
      workspace::device_info,
      remote::cmds::ssh_test,
      remote::cmds::ssh_host_fingerprint,
      remote::cmds::ssh_list_dir,
      remote::cmds::ssh_make_dir,
      remote::cmds::ssh_reconnect,
      remote::cmds::ssh_forget,
      remote::claude::ssh_claude_status,
      remote::claude::ssh_claude_install,
      remote::claude::ssh_claude_login_start,
      remote::claude::ssh_claude_login_code,
      remote::claude::ssh_claude_login_cancel,
      chat::chat_send,
      chat::chat_cancel,
      chat::chat_codex_models,
      chat::chat_attach_save,
      chat::chat_attach_read,
      chat::chat_delete_files,
      workspace::create_project_dir,
      workspace::create_project_entry,
      workspace::move_project_entry,
      workspace::rename_project_entry,
      workspace::delete_project_entry,
      workspace::git_revert,
      workspace::import_into_project,
      workspace::list_project_files,
      workspace::read_project_file,
      workspace::read_project_file_bytes,
      sheet::read_project_sheet,
      home::home_fetch_cpi,
      home::home_fetch_effr,
      home_fetch::home_fetch,
      terminal::terminal_attach,
      terminal::terminal_detach,
      terminal::terminal_write,
      terminal::terminal_resize,
      terminal::terminal_restart,
      workspace::git_status,
      workspace::ensure_project_docs,
      workspace::git_diff,
      workspace::git_commit,
      workspace::git_push,
      workspace::open_project_folder,
      workspace::open_external_url,
      watch::watch_project,
      watch::unwatch_project,
      agent::agent_detect,
      agent::agent_run,
      agent::agent_cancel,
      agent::agent_respond,
      agent::memory_analyze,
      agent::claude_plan,
      agent::claude_usage_probe,
      memory::memory_sync_pull,
      memory::memory_sync_push,
      memory::memory_sync_candidates,
      memory::memory_sync_location,
      memory::music_sync_pull,
      memory::music_sync_push,
      memory::home_sync_pull,
      memory::home_sync_push,
      memory::memory_export,
      memory::project_memory_add,
      music::music_tool_status,
      music::music_tool_install,
      music::music_tool_update,
      music::music_download,
      music::music_files,
      music::music_read,
      music::music_delete_file,
    ])
    .setup(|app| {
      tray::setup(app.handle());
      cleanup::spawn_startup_cleanup(app.package_info().version.to_string());
      session::start(app.handle().clone());
      // 옵션이 켜져 있으면 등록이 맞는지 다시 맞춘다 (앱이 옮겨졌거나 등록이 지워진 경우)
      if options::autostart(app.handle()) {
        if let Err(error) = apply_autostart(app.handle(), true) {
          log::warn!("자동 시작 등록을 확인하지 못했습니다: {error}");
        }
      }
      // 창은 숨긴 상태로 만들어 두고 여기서 보인다. 자동 시작(--hidden)이고 트레이가 있을 때만 숨긴 채 둔다
      // (트레이가 없으면 창을 다시 열 방법이 없으므로 보인다).
      let hidden_start = std::env::args().any(|a| a == HIDDEN_ARG) && app.state::<tray::TrayState>().available();
      if !hidden_start {
        tray::show_main_window(app.handle());
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // 앱을 끌 때 터미널 셸 프로세스도 함께 끈다
      if let tauri::RunEvent::Exit = event {
        app.state::<terminal::TerminalState>().shutdown();
      }
    });
}
