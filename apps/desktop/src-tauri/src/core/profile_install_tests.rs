use super::*;
use std::sync::Barrier;

fn fixture() -> (tempfile::TempDir, Arc<ProfileService>, ProfileRecord) {
    let root = tempfile::tempdir().unwrap();
    let binary_path = root.path().join("fixture-browser");
    std::fs::write(&binary_path, b"synthetic browser").unwrap();
    let service = Arc::new(ProfileService::new(root.path().join("profiles")).unwrap());
    let window = service
        .create_prepared(
            "Install guard fixture",
            ProxySource::direct(),
            WindowSettings::default(),
            PreparedBinary {
                version: "145.0.7632.109".into(),
                binary_path,
            },
            None,
        )
        .unwrap();
    let record = service.store.get(&window.id).unwrap();
    (root, service, record)
}

#[test]
fn note_edits_do_not_interrupt_active_window_sessions() {
    for phase in [Phase::Launching, Phase::Running, Phase::Stopping] {
        let (_root, service, record) = fixture();
        {
            let mut state = service.state.lock().unwrap();
            let snapshot = state
                .scheduler
                .reserve(LaunchRequest {
                    window_id: record.id.clone(),
                    profile_id: record.id.clone(),
                    channel_id: record.binding.channel_id.clone(),
                    proxy: ProxyBinding::Direct,
                })
                .unwrap();
            if phase != Phase::Launching {
                state.scheduler.mark_running(&snapshot).unwrap();
            }
            if phase == Phase::Stopping {
                state.scheduler.begin_stop(&snapshot).unwrap();
            }
        }
        assert_eq!(
            service.update_note(&record.id, "new note").unwrap(),
            "new note"
        );
        assert_eq!(
            service
                .state
                .lock()
                .unwrap()
                .scheduler
                .status(&record.id)
                .unwrap()
                .phase,
            phase
        );
        let mut expected = record;
        expected.settings.note = "new note".into();
        assert_eq!(service.store.get(&expected.id).unwrap(), expected);
    }
}

#[test]
fn note_edits_respect_transfer_recovery_and_install_guards() {
    let (_root, service, record) = fixture();
    let transfer = service
        .lock_transfer(std::slice::from_ref(&record.id))
        .unwrap();
    assert!(
        service
            .update_note(&record.id, "not during transfer")
            .is_err()
    );
    assert_eq!(service.store.get(&record.id).unwrap(), record);
    drop(transfer);
    let install = service.lock_app_install().unwrap();
    assert_eq!(
        service
            .update_note(&record.id, "not during install")
            .unwrap_err(),
        APP_INSTALLING
    );
    assert_eq!(service.store.get(&record.id).unwrap(), record);
    drop(install);
    assert!(service.update_note(&record.id, "after guards").is_ok());
    service
        .block_recovery(std::slice::from_ref(&record.id))
        .unwrap();
    assert_eq!(
        service
            .update_note(&record.id, "not during recovery")
            .unwrap_err(),
        RECOVERY_PENDING
    );
}

#[test]
fn install_guard_rejects_every_scheduler_phase_even_without_a_session_child() {
    for phase in [Phase::Launching, Phase::Running, Phase::Stopping] {
        let (_root, service, record) = fixture();
        let snapshot = {
            let mut state = service.state.lock().unwrap();
            let snapshot = state
                .scheduler
                .reserve(LaunchRequest {
                    window_id: record.id.clone(),
                    profile_id: record.id.clone(),
                    channel_id: record.binding.channel_id.clone(),
                    proxy: ProxyBinding::Direct,
                })
                .unwrap();
            if phase != Phase::Launching {
                state.scheduler.mark_running(&snapshot).unwrap();
            }
            if phase == Phase::Stopping {
                state.scheduler.begin_stop(&snapshot).unwrap();
            }
            snapshot
        };
        assert_eq!(
            service.lock_app_install().err(),
            Some("running_windows"),
            "installation was admitted during {phase:?}",
        );
        service
            .state
            .lock()
            .unwrap()
            .scheduler
            .process_exited(&snapshot)
            .unwrap();
        assert!(service.lock_app_install().is_ok());
    }
}

#[test]
fn install_guard_rejects_profile_reservations_before_scheduler_reservation() {
    let (_root, service, record) = fixture();
    let pending_proxy_or_transfer = service
        .lock_transfer(std::slice::from_ref(&record.id))
        .unwrap();
    assert!(!service.list().unwrap()[0].running);
    assert_eq!(service.lock_app_install().err(), Some("running_windows"));
    drop(pending_proxy_or_transfer);
    assert!(service.lock_app_install().is_ok());
}

#[test]
fn install_resource_blocks_new_work_until_failed_install_releases_it() {
    let (_root, service, record) = fixture();
    let marker = service
        .store
        .user_data_dir(&record.id)
        .unwrap()
        .join("original-state");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(&marker, b"preserved synthetic data").unwrap();
    let mut resources = tauri::ResourceTable::default();
    let rid = resources.add(service.lock_app_install().unwrap());

    assert_eq!(service.lock_app_install().err(), Some("running_windows"));
    assert_eq!(service.launch(&record.id).unwrap_err(), APP_INSTALLING);
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_err()
    );
    assert!(service.lock_transfer_operation().is_err());
    assert_eq!(service.store.get(&record.id).unwrap(), record);
    assert_eq!(std::fs::read(&marker).unwrap(), b"preserved synthetic data");

    resources.close(rid).unwrap();
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_ok()
    );
    assert!(service.lock_transfer_operation().is_ok());
    assert!(service.lock_app_install().is_ok());
}

#[test]
fn install_guard_waits_for_all_transfer_operations_and_recovery() {
    let (_root, service, record) = fixture();
    let first = service.lock_transfer_operation().unwrap();
    let second = service.lock_transfer_operation().unwrap();
    assert_eq!(service.lock_app_install().err(), Some("running_windows"));
    drop(first);
    assert_eq!(service.lock_app_install().err(), Some("running_windows"));
    drop(second);
    assert!(service.lock_app_install().is_ok());
    service.block_recovery(&[record.id]).unwrap();
    assert_eq!(service.lock_app_install().err(), Some("profiles_failed"));
}

#[test]
fn install_and_transfer_admission_are_atomic_in_both_orders() {
    let (_root, service, record) = fixture();
    for _ in 0..32 {
        let start = Barrier::new(2);
        let admitted = Barrier::new(2);
        std::thread::scope(|scope| {
            let install = scope.spawn(|| {
                start.wait();
                let guard = service.lock_app_install();
                admitted.wait();
                guard.is_ok()
            });
            let transfer = scope.spawn(|| {
                start.wait();
                let guard = service.lock_transfer(std::slice::from_ref(&record.id));
                admitted.wait();
                guard.is_ok()
            });
            assert_ne!(install.join().unwrap(), transfer.join().unwrap());
        });
    }
}
