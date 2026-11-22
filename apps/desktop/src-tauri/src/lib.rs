pub mod core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    };
    const EXIT_READY: u8 = 0;
    const EXIT_STOPPING_BROWSERS: u8 = 1;
    const EXIT_BROWSERS_HANDLED: u8 = 2;
    let exit_phase = Arc::new(AtomicU8::new(EXIT_READY));
    use tauri::Manager;
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            core::workbench_settings::show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(|app| {
            #[cfg(not(target_os = "macos"))]
            if app.config().identifier == "com.raccoon.desktop" {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_decorations(false)?;
                }
            }
            core::plugin_service::initialize(app)?;
            core::workbench_settings::initialize(app.handle()).map_err(std::io::Error::other)?;
            core::automation::host::initialize(app).map_err(std::io::Error::other)?;
            core::automation::http::initialize(app).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let ns_window = window.ns_window()?;
                unsafe {
                    let window = &*ns_window.cast::<objc2_app_kit::NSWindow>();
                    window.setMovableByWindowBackground(false);
                }
            }
            Ok(())
        })
        .on_window_event(core::workbench_settings::window_event)
        .invoke_handler(tauri::generate_handler![
            core::automation::commands::browser_automation_available,
            core::automation::commands::browser_automation_capabilities,
            core::automation::commands::browser_automation_list,
            core::automation::commands::browser_automation_create,
            core::automation::commands::browser_automation_save,
            core::automation::commands::browser_automation_delete,
            core::automation::commands::browser_automation_duplicate,
            core::automation::commands::browser_automation_attach,
            core::automation::commands::browser_automation_detach,
            core::automation::commands::browser_automation_attached,
            core::automation::commands::browser_automation_screencast,
            core::automation::commands::browser_automation_call,
            core::automation::commands::browser_automation_launch,
            core::automation::commands::browser_automation_pick,
            core::automation::commands::browser_automation_run,
            core::automation::commands::browser_automation_run_stop,
            core::automation::commands::browser_automation_run_status,
            core::automation::commands::browser_automation_run_reconcile,
            core::automation::commands::browser_automation_fleet,
            core::automation::commands::browser_automation_fleet_window,
            core::automation::commands::browser_automation_tls_fingerprints,
            core::automation::commands::browser_automation_modules,
            core::automation::commands::browser_automation_module_permissions,
            core::automation::commands::browser_automation_module_grant,
            core::automation::commands::browser_automation_module_install,
            core::automation::commands::browser_automation_module_remove,
            core::automation::commands::browser_automation_modules_dir,
            core::automation::commands::browser_automation_export,
            core::automation::commands::browser_automation_import,
            core::automation::commands::browser_automation_display,
            core::automation::commands::browser_automation_helper_fields,
            core::automation::commands::browser_automation_helper_fill,
            core::automation::commands::browser_automation_helper_profiles,
            core::automation::commands::browser_automation_helper_show,
            core::automation::commands::browser_automation_helper_close,
            core::automation::commands::browser_automation_helper_dismiss,
            core::automation::http::browser_automation_http_start,
            core::automation::http::browser_automation_http_status,
            core::automation::http::browser_automation_http_stop,
            core::automation::http::browser_automation_http_token,
            core::automation::http::browser_automation_http_rotate_token,
            core::automation::http::browser_automation_mcp_download,
            core::workbench_settings::workbench_settings_get,
            core::workbench_settings::workbench_settings_set,
            core::workbench_settings::workbench_info,
            core::workbench_settings::workbench_storage_reveal,
            core::external_url::external_url_open,
            core::configuration_service::configuration_file_export,
            core::plugin_pdf_export::plugin_pdf_export,
            core::configuration_service::configuration_file_import,
            core::browser::proxy_library::browser_proxy_list,
            core::browser::proxy_library::browser_proxy_save,
            core::browser::proxy_library::browser_proxy_delete,
            core::browser::proxy_library::browser_proxy_usage,
            core::browser::proxy_library::browser_proxy_full_test,
            core::browser::proxy_library::browser_proxy_last_test,
            core::browser::proxy_library::browser_proxy_history,
            core::browser::proxy_library::browser_proxy_bulk_parse,
            core::browser::proxy_library::browser_proxy_bulk_save,
            core::browser::proxy_library::browser_proxy_bulk_import,
            core::clipboard::browser_clipboard_read,
            core::clipboard::browser_clipboard_write,
            core::window_service::browser_window_list,
            core::workbench_tags::browser_tag_list,
            core::workbench_tags::browser_tag_save,
            core::workbench_tags::browser_tag_delete,
            core::workbench_tags::browser_tag_assign,
            core::workbench_trash::browser_trash_list,
            core::workbench_trash::browser_profile_trash,
            core::workbench_trash::browser_trash_restore,
            core::workbench_trash::browser_trash_purge,
            core::workbench_trash::browser_trash_empty,
            core::window_service::browser_window_create,
            core::window_service::browser_window_update,
            core::window_service::browser_window_update_note,
            core::window_service::browser_window_move_group,
            core::window_service::browser_window_delete,
            core::window_service::browser_window_start,
            core::window_service::browser_window_stop,
            core::window_service::browser_cloakbrowser_cleanup,
            core::window_service::browser_cloakbrowser_sessions,
            core::window_service::browser_connection_list,
            core::window_service::browser_managed_cloakbrowser_set,
            core::window_service::browser_managed_aliasmode_set,
            core::window_service::browser_managed_shardbrowser_set,
            core::shardbrowser_kernels::shardbrowser_kernel_status,
            core::shardbrowser_kernels::shardbrowser_kernel_download,
            core::shardbrowser_kernels::shardbrowser_kernel_delete,
            core::shardbrowser_fingerprints::shardbrowser_fingerprint_list,
            core::shardbrowser_fingerprints::shardbrowser_fingerprint_import,
            core::shardbrowser_fingerprints::shardbrowser_fingerprint_delete,
            core::shardbrowser_fingerprints::shardbrowser_fingerprint_dir,
            core::shardbrowser_fingerprints::shardbrowser_fingerprint_reveal,
            core::shardbrowser_fingerprints::shardbrowser_fingerprint_enrich_picks,
            core::shardbrowser_fingerprints::shardbrowser_profile_config,
            core::shardbrowser_fingerprints::shardbrowser_host_hardware,
            core::shardbrowser_fingerprints::shardbrowser_host_screen,
            core::shardbrowser_bookmarks::shardbrowser_bookmark_list,
            core::shardbrowser_bookmarks::shardbrowser_bookmark_save,
            core::shardbrowser_bookmarks::shardbrowser_bookmark_delete,
            core::shardbrowser_bookmarks::shardbrowser_bookmark_delete_many,
            core::shardbrowser_extensions::shardbrowser_extension_list,
            core::shardbrowser_extensions::shardbrowser_extension_import,
            core::shardbrowser_extensions::shardbrowser_extension_import_url,
            core::shardbrowser_extensions::shardbrowser_extension_delete,
            core::shardbrowser_extensions::shardbrowser_extension_updates,
            core::shardbrowser_extensions::shardbrowser_extension_updates_check,
            core::shardbrowser_extensions::shardbrowser_extension_update,
            core::shardbrowser_extensions::shardbrowser_extension_link_source,
            core::shardbrowser_extensions::shardbrowser_extension_update_cancel,
            core::shardbrowser_extensions::shardbrowser_extension_update_skip,
            core::shardbrowser_gpu::shardbrowser_gpu_caps,
            core::shardbrowser_gpu::shardbrowser_gpu_compat,
            core::shardbrowser_profiles::shardbrowser_cookies_import,
            core::shardbrowser_profiles::shardbrowser_cookies_export_to_file,
            core::shardbrowser_profiles::shardbrowser_profile_cdp,
            core::shardbrowser_profiles::shardbrowser_profile_focus,
            core::shardbrowser_profiles::browser_window_set_pin,
            core::aliasmode_kernels::aliasmode_kernel_status,
            core::aliasmode_kernels::aliasmode_kernel_job,
            core::aliasmode_kernels::aliasmode_kernel_check_latest,
            core::aliasmode_kernels::aliasmode_kernel_download,
            core::aliasmode_kernels::aliasmode_kernel_delete,
            core::window_service::browser_connection_save,
            core::window_service::browser_connection_probe,
            core::window_service::browser_bitbrowser_launch,
            core::window_service::browser_connection_confirm,
            core::window_service::browser_connection_activate,
            core::window_service::browser_profile_discover,
            core::window_service::browser_group_list,
            core::window_service::browser_window_attach,
            core::window_service::browser_operation_list,
            core::window_service::browser_operation_get,
            core::window_service::browser_operation_reconcile,
            core::window_service::browser_operation_resolve,
            core::transfer_service::window_transfer_pick,
            core::transfer_service::window_transfer_recovery_status,
            core::transfer_service::window_transfer_export,
            core::transfer_service::window_transfer_inspect,
            core::transfer_service::window_transfer_import,
            core::transfer_service::window_sync_offer,
            core::transfer_service::window_sync_receive,
            core::transfer_service::window_sync_status,
            core::transfer_service::window_sync_cancel,
            core::transfer_service::window_sync_import,
            core::updater_service::app_update_check,
            core::updater_service::app_update_begin_install,
            core::kernel_service::kernel_status,
            core::kernel_service::kernel_check_latest,
            core::kernel_service::kernel_download,
            core::kernel_service::kernel_delete,
            core::license_service::license_status,
            core::license_service::license_seats,
            core::license_service::license_set,
            core::license_service::license_remove,
            core::network_proxy::network_proxy_get,
            core::network_proxy::network_proxy_set,
            core::group_store::group_list,
            core::group_store::group_create,
            core::group_store::group_update,
            core::group_store::group_delete,
            core::group_store::browser_folder_list,
            core::group_store::browser_folder_create,
            core::group_store::browser_folder_update,
            core::group_store::browser_folder_delete,
            core::plugin_service::plugin_catalog,
            core::plugin_ui::plugin_ui_command,
            core::plugin_ui::plugin_ui_task_command,
            core::plugin_ui::plugin_ui_profiles,
            core::plugin_service::plugin_license_status,
            core::plugin_service::plugin_license_activate,
            core::plugin_service::plugin_proxy_providers,
            core::plugin_service::plugin_install,
            core::plugin_service::plugin_uninstall,
            core::plugin_service::plugin_call,
            core::plugin_service::plugin_market_status,
            core::plugin_service::plugin_market_set_store,
            core::plugin_service::plugin_market_refresh,
            core::plugin_service::plugin_market_install,
            core::agent::commands::sales_agent_batch_create,
            core::agent::commands::sales_agent_batch_list,
            core::agent::commands::sales_agent_batch_get,
            core::agent::commands::sales_agent_batch_control,
            core::agent::commands::sales_agent_events,
            core::agent::commands::sales_agent_preflight,
            core::agent::commands::sales_agent_job_control,
            core::agent::commands::sales_agent_items,
            core::agent::commands::sales_agent_item_control,
            core::agent::commands::sales_agent_artifact_preview,
            core::agent::commands::sales_agent_workspace_list,
            core::agent::commands::sales_agent_workspace_get,
            core::agent::commands::sales_agent_workspace_save,
            core::agent::commands::sales_agent_workspace_delete,
            core::agent::commands::sales_agent_usage,
            core::agent::commands::sales_agent_model_requests,
            core::agent::commands::sales_agent_retention_preview,
            core::agent::commands::sales_agent_retention_clean,
            core::agent::commands::sales_agent_attention,
            core::agent::commands::sales_agent_related
        ])
        .build(tauri::generate_context!())
        .expect("Raccoon could not initialize its desktop runtime")
        .run(move |app, event| {
            use tauri::Manager;
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. })
                && app
                    .get_webview_window("main")
                    .is_some_and(|window| matches!(window.is_visible(), Ok(false)))
            {
                core::workbench_settings::show_main_window(app);
            }
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event
                && let Some(windows) = app.try_state::<Arc<core::window_service::WindowService>>()
            {
                if *code == Some(tauri::RESTART_EXIT_CODE) {
                    windows.builtin.shutdown();
                } else if exit_phase.load(Ordering::Acquire) != EXIT_BROWSERS_HANDLED {
                    api.prevent_exit();
                    if exit_phase
                        .compare_exchange(
                            EXIT_READY,
                            EXIT_STOPPING_BROWSERS,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        let app = app.clone();
                        let browser = windows.builtin.clone();
                        let exit_phase = exit_phase.clone();
                        let code = code.unwrap_or(0);
                        tauri::async_runtime::spawn_blocking(move || {
                            browser.shutdown();
                            exit_phase.store(EXIT_BROWSERS_HANDLED, Ordering::Release);
                            app.exit(code);
                        });
                    }
                    return;
                }
            }
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(automation) =
                    app.try_state::<std::sync::Arc<core::automation::AutomationService>>()
                {
                    automation.shutdown();
                }
                if let Some(agent) = app.try_state::<std::sync::Arc<core::agent::AgentService>>() {
                    agent.shutdown();
                }
                if let Some(host) = app.try_state::<std::sync::Arc<core::plugin_host::PluginHost>>()
                {
                    host.shutdown();
                }
            }
        });
}
