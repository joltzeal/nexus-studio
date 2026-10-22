use super::plugins::{
    Capability, PluginDescriptor, PluginError, ProxyProviderPort, ProxyReference,
};
use super::scheduler::{
    EngineCapacity, EngineChannel, LaunchRequest, Phase, ProxyBinding, Scheduler, SchedulerError,
};
use super::{Core, CoreError, ProxyChoice, WindowIntent};
use std::num::NonZeroUsize;

fn channel(id: &str, version: &str, capacity: EngineCapacity) -> EngineChannel {
    EngineChannel {
        id: id.into(),
        version: version.into(),
        capacity,
    }
}

fn limited(n: usize) -> EngineCapacity {
    EngineCapacity::Limited(NonZeroUsize::new(n).unwrap())
}

fn request(window: &str, profile: &str, channel: &str) -> LaunchRequest {
    LaunchRequest {
        window_id: window.into(),
        profile_id: profile.into(),
        channel_id: channel.into(),
        proxy: ProxyBinding::Direct,
    }
}

fn bind(scheduler: &mut Scheduler, profile: &str, channel: &str) {
    let binding = scheduler.propose_profile_binding(profile, channel).unwrap();
    scheduler.restore_profile(binding).unwrap();
}

#[test]
fn unbound_profile_cannot_be_launched() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", limited(1)))
        .unwrap();
    assert_eq!(
        scheduler.reserve(request("a", "existing-profile", "current")),
        Err(SchedulerError::ProfileNotBound)
    );
}

#[test]
fn profile_stays_on_its_original_engine_after_stop() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("old", "146", limited(1)))
        .unwrap();
    scheduler
        .register_channel(channel("current", "155", limited(1)))
        .unwrap();
    let binding = scheduler
        .propose_profile_binding("profile-a", "old")
        .unwrap();
    scheduler.restore_profile(binding.clone()).unwrap();
    assert_eq!(binding.channel_version, "146");
    let first = scheduler.reserve(request("a", "profile-a", "old")).unwrap();
    scheduler.mark_running(&first).unwrap();
    scheduler.begin_stop(&first).unwrap();
    scheduler.finish_stop(&first).unwrap();
    assert_eq!(
        scheduler.reserve(request("a", "profile-a", "current")),
        Err(SchedulerError::ProfileEngineMismatch)
    );
    assert_eq!(
        scheduler.propose_profile_binding("profile-a", "current"),
        Err(SchedulerError::ProfileAlreadyBound)
    );
    assert_eq!(scheduler.active_count("current"), 0);
}

#[test]
fn a_restored_profile_rejects_an_updated_binary_for_the_same_channel() {
    let mut first = Scheduler::default();
    first
        .register_channel(channel("current", "155.0.1", limited(1)))
        .unwrap();
    let binding = first
        .propose_profile_binding("profile-a", "current")
        .unwrap();

    let mut restarted = Scheduler::default();
    restarted
        .register_channel(channel("current", "155.0.2", limited(1)))
        .unwrap();
    restarted.restore_profile(binding).unwrap();
    assert_eq!(
        restarted.reserve(request("a", "profile-a", "current")),
        Err(SchedulerError::ProfileEngineMismatch)
    );
}

#[test]
fn unknown_capacity_fails_closed_and_does_not_reserve() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", EngineCapacity::Unknown))
        .unwrap();
    bind(&mut scheduler, "profile-a", "current");
    assert_eq!(
        scheduler.reserve(request("a", "profile-a", "current")),
        Err(SchedulerError::CapacityUnverified)
    );
    assert_eq!(scheduler.active_count("current"), 0);
}

#[test]
fn a_slot_is_held_during_start_run_and_stop() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", limited(1)))
        .unwrap();
    bind(&mut scheduler, "profile-a", "current");
    bind(&mut scheduler, "profile-b", "current");
    let snapshot = scheduler
        .reserve(request("a", "profile-a", "current"))
        .unwrap();
    assert_eq!(snapshot.channel_version, "155");
    assert_eq!(
        scheduler.reserve(request("b", "profile-b", "current")),
        Err(SchedulerError::CapacityExhausted)
    );
    scheduler.mark_running(&snapshot).unwrap();
    assert_eq!(scheduler.status("a").unwrap().phase, Phase::Running);
    scheduler.begin_stop(&snapshot).unwrap();
    assert_eq!(
        scheduler.reserve(request("b", "profile-b", "current")),
        Err(SchedulerError::CapacityExhausted)
    );
    scheduler.finish_stop(&snapshot).unwrap();
    assert!(
        scheduler
            .reserve(request("b", "profile-b", "current"))
            .is_ok()
    );
}

#[test]
fn provider_enforced_capacity_allows_distinct_profiles_to_reach_the_browser() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", EngineCapacity::ProviderEnforced))
        .unwrap();
    bind(&mut scheduler, "profile-a", "current");
    bind(&mut scheduler, "profile-b", "current");

    let first = scheduler
        .reserve(request("window-a", "profile-a", "current"))
        .unwrap();
    let second = scheduler
        .reserve(request("window-b", "profile-b", "current"))
        .unwrap();

    assert_eq!(scheduler.active_count("current"), 2);
    assert_eq!(first.profile_id, "profile-a");
    assert_eq!(second.profile_id, "profile-b");
    assert_eq!(
        scheduler.reserve(request("window-c", "profile-a", "current")),
        Err(SchedulerError::ProfileBusy)
    );
}

#[test]
fn profile_ownership_is_global_even_across_engine_versions() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("old", "146", limited(2)))
        .unwrap();
    scheduler
        .register_channel(channel("current", "155", limited(2)))
        .unwrap();
    bind(&mut scheduler, "same-profile", "old");
    scheduler
        .reserve(request("a", "same-profile", "old"))
        .unwrap();
    assert_eq!(
        scheduler.reserve(request("b", "same-profile", "current")),
        Err(SchedulerError::ProfileBusy)
    );
}

#[test]
fn failed_start_releases_only_its_own_generation() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", limited(1)))
        .unwrap();
    bind(&mut scheduler, "profile-a", "current");
    let first = scheduler
        .reserve(request("a", "profile-a", "current"))
        .unwrap();
    scheduler.start_failed(&first).unwrap();
    let second = scheduler
        .reserve(request("a", "profile-a", "current"))
        .unwrap();
    assert_ne!(first.generation, second.generation);
    assert_eq!(
        scheduler.mark_running(&first),
        Err(SchedulerError::StaleAttempt)
    );
    assert_eq!(
        scheduler.start_failed(&first),
        Err(SchedulerError::StaleAttempt)
    );
    assert_eq!(scheduler.status("a").unwrap().snapshot, second);
}

#[test]
fn no_automatic_engine_fallback_when_current_is_full() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("old", "146", limited(3)))
        .unwrap();
    scheduler
        .register_channel(channel("current", "155", limited(1)))
        .unwrap();
    bind(&mut scheduler, "a", "current");
    bind(&mut scheduler, "b", "current");
    scheduler.reserve(request("a", "a", "current")).unwrap();
    assert_eq!(
        scheduler.reserve(request("b", "b", "current")),
        Err(SchedulerError::CapacityExhausted)
    );
    assert_eq!(scheduler.active_count("old"), 0);
}

#[test]
fn reduced_capacity_keeps_running_windows_but_blocks_new_ones() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", limited(2)))
        .unwrap();
    bind(&mut scheduler, "a", "current");
    bind(&mut scheduler, "b", "current");
    bind(&mut scheduler, "c", "current");
    let a = scheduler.reserve(request("a", "a", "current")).unwrap();
    scheduler.reserve(request("b", "b", "current")).unwrap();
    scheduler.set_capacity("current", limited(1)).unwrap();
    assert_eq!(scheduler.active_count("current"), 2);
    scheduler.start_failed(&a).unwrap();
    assert_eq!(
        scheduler.reserve(request("c", "c", "current")),
        Err(SchedulerError::CapacityExhausted)
    );
}

struct ProxyPort {
    fails: bool,
    empty_handle: bool,
}

impl ProxyProviderPort for ProxyPort {
    async fn resolve_proxy(
        &self,
        _plugin_id: &str,
        _window_id: &str,
    ) -> Result<ProxyReference, PluginError> {
        if self.fails {
            Err(PluginError::Unavailable)
        } else {
            Ok(ProxyReference {
                config_handle: if self.empty_handle {
                    ""
                } else {
                    "opaque-proxy-ref"
                }
                .into(),
                secret_ref: Some("credential-ref".into()),
            })
        }
    }
}

fn intent() -> WindowIntent {
    WindowIntent {
        window_id: "a".into(),
        profile_id: "profile-a".into(),
        channel_id: "current".into(),
        proxy: ProxyChoice::Required {
            plugin_id: "proxy.sample".into(),
        },
    }
}

#[test]
fn required_proxy_must_be_registered_and_resolved_before_a_slot_is_held() {
    tauri::async_runtime::block_on(async {
        let mut core = Core::new(ProxyPort {
            fails: true,
            empty_handle: false,
        });
        core.scheduler
            .register_channel(channel("current", "155", limited(1)))
            .unwrap();
        bind(&mut core.scheduler, "profile-a", "current");
        assert_eq!(
            core.reserve_window(intent()).await,
            Err(CoreError::Plugin(PluginError::NotRegistered))
        );
        core.plugins
            .register(PluginDescriptor {
                id: "proxy.sample".into(),
                api_version: 1,
                capabilities: vec![Capability::ProxyProvider],
            })
            .unwrap();
        assert_eq!(
            core.reserve_window(intent()).await,
            Err(CoreError::ProxyResolutionFailed)
        );
        assert_eq!(core.scheduler.active_count("current"), 0);
    });
}

#[test]
fn resolved_proxy_is_an_opaque_reference_in_the_snapshot() {
    tauri::async_runtime::block_on(async {
        let mut core = Core::new(ProxyPort {
            fails: false,
            empty_handle: false,
        });
        core.scheduler
            .register_channel(channel("current", "155", limited(1)))
            .unwrap();
        bind(&mut core.scheduler, "profile-a", "current");
        core.plugins
            .register(PluginDescriptor {
                id: "proxy.sample".into(),
                api_version: 1,
                capabilities: vec![Capability::ProxyProvider],
            })
            .unwrap();
        let snapshot = core.reserve_window(intent()).await.unwrap();
        assert_eq!(
            snapshot.proxy,
            ProxyBinding::Required {
                plugin_id: "proxy.sample".into(),
                config_handle: "opaque-proxy-ref".into(),
                secret_ref: Some("credential-ref".into()),
            }
        );
    });
}

#[test]
fn empty_proxy_reference_blocks_reservation() {
    tauri::async_runtime::block_on(async {
        let mut core = Core::new(ProxyPort {
            fails: false,
            empty_handle: true,
        });
        core.scheduler
            .register_channel(channel("current", "155", limited(1)))
            .unwrap();
        bind(&mut core.scheduler, "profile-a", "current");
        core.plugins
            .register(PluginDescriptor {
                id: "proxy.sample".into(),
                api_version: 1,
                capabilities: vec![Capability::ProxyProvider],
            })
            .unwrap();
        assert_eq!(
            core.reserve_window(intent()).await,
            Err(CoreError::ProxyResolutionFailed)
        );
        assert_eq!(core.scheduler.active_count("current"), 0);
    });
}

#[test]
fn plugin_registry_rejects_wrong_api_and_missing_capability() {
    let mut registry = super::plugins::PluginRegistry::default();
    assert_eq!(
        registry.register(PluginDescriptor {
            id: "proxy.sample".into(),
            api_version: 2,
            capabilities: vec![Capability::ProxyProvider],
        }),
        Err(PluginError::UnsupportedApiVersion)
    );
    registry
        .register(PluginDescriptor {
            id: "proxy.sample".into(),
            api_version: 1,
            capabilities: vec![Capability::ImageProvider],
        })
        .unwrap();
    assert_eq!(
        registry.require("proxy.sample", Capability::ProxyProvider),
        Err(PluginError::CapabilityMissing)
    );
    assert_eq!(
        registry.register(PluginDescriptor {
            id: "proxy.sample".into(),
            api_version: 1,
            capabilities: vec![Capability::ProxyProvider],
        }),
        Err(PluginError::AlreadyRegistered)
    );
}

#[test]
fn unexpected_browser_exit_releases_the_slot_and_ignores_late_events() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", limited(1)))
        .unwrap();
    bind(&mut scheduler, "a", "current");
    let old = scheduler.reserve(request("a", "a", "current")).unwrap();
    scheduler.mark_running(&old).unwrap();
    scheduler.process_exited(&old).unwrap();
    let next = scheduler.reserve(request("a", "a", "current")).unwrap();
    assert_eq!(
        scheduler.process_exited(&old),
        Err(SchedulerError::StaleAttempt)
    );
    assert_eq!(scheduler.status("a").unwrap().snapshot, next);
}

#[test]
fn stopping_a_launch_holds_capacity_until_process_exit() {
    let mut scheduler = Scheduler::default();
    scheduler
        .register_channel(channel("current", "155", limited(1)))
        .unwrap();
    bind(&mut scheduler, "a", "current");
    bind(&mut scheduler, "b", "current");
    let attempt = scheduler.reserve(request("a", "a", "current")).unwrap();
    scheduler.begin_stop(&attempt).unwrap();
    assert_eq!(
        scheduler.mark_running(&attempt),
        Err(SchedulerError::InvalidTransition)
    );
    assert_eq!(
        scheduler.reserve(request("b", "b", "current")),
        Err(SchedulerError::CapacityExhausted)
    );
    scheduler.process_exited(&attempt).unwrap();
    assert!(scheduler.reserve(request("b", "b", "current")).is_ok());
}
