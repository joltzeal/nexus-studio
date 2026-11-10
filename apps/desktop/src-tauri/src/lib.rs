pub mod core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(core::plugin_service::initialize)
        .invoke_handler(tauri::generate_handler![
            core::external_url::external_url_open,
            core::window_service::browser_window_list,
            core::window_service::browser_window_create,
            core::window_service::browser_window_update,
            core::window_service::browser_window_update_note,
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
            core::plugin_service::plugin_market_install
        ])
        .run(tauri::generate_context!())
        .expect("Nexus could not initialize its desktop runtime");
}
