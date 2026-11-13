pub mod core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(core::plugin_service::initialize)
        .invoke_handler(tauri::generate_handler![
            core::external_url::external_url_open,
            core::configuration_service::configuration_file_export,
            core::configuration_service::configuration_file_import,
            core::window_service::browser_window_list,
            core::window_service::browser_window_create,
            core::window_service::browser_window_update,
            core::window_service::browser_window_update_note,
            core::window_service::browser_window_move_group,
            core::window_service::browser_window_delete,
            core::window_service::browser_window_start,
            core::window_service::browser_window_stop,
            core::window_service::browser_connection_list,
            core::window_service::browser_connection_save,
            core::window_service::browser_connection_probe,
            core::window_service::browser_connection_confirm,
            core::window_service::browser_connection_activate,
            core::window_service::browser_profile_discover,
            core::window_service::browser_group_list,
            core::window_service::browser_window_attach,
            core::window_service::browser_operation_list,
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
            core::license_service::license_status,
            core::license_service::license_set,
            core::license_service::license_remove,
            core::network_proxy::network_proxy_get,
            core::network_proxy::network_proxy_set,
            core::group_store::group_list,
            core::group_store::group_create,
            core::group_store::group_update,
            core::group_store::group_delete,
            core::plugin_service::plugin_catalog,
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
        .expect("Nexus could not initialize its desktop runtime")
        .run(|app, event| {
            use tauri::Manager;
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
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
