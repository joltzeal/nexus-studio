pub mod core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_process::init());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(core::plugin_service::initialize)
        .invoke_handler(tauri::generate_handler![
            core::profile_service::profile_list,
            core::profile_service::profile_create,
            core::profile_service::profile_update,
            core::profile_service::profile_delete,
            core::profile_service::profile_launch,
            core::profile_service::profile_stop,
            core::license_service::license_status,
            core::license_service::license_set,
            core::license_service::license_remove,
            core::group_store::group_list,
            core::group_store::group_create,
            core::group_store::group_update,
            core::group_store::group_delete,
            core::plugin_service::plugin_catalog,
            core::plugin_service::plugin_proxy_providers,
            core::plugin_service::plugin_install,
            core::plugin_service::plugin_uninstall,
            core::plugin_service::plugin_call
        ])
        .run(tauri::generate_context!())
        .expect("Nexus could not initialize its desktop runtime");
}
