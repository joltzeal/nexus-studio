use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::num::NonZeroUsize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineCapacity {
    Unknown,
    Limited(NonZeroUsize),
    ProviderEnforced,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineChannel {
    pub id: String,
    pub version: String,
    pub capacity: EngineCapacity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileBinding {
    pub profile_id: String,
    pub channel_id: String,
    pub channel_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyBinding {
    Direct,
    Configured {
        server: String,
    },
    Required {
        plugin_id: String,
        config_handle: String,
        secret_ref: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchRequest {
    pub window_id: String,
    pub profile_id: String,
    pub channel_id: String,
    pub proxy: ProxyBinding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSnapshot {
    pub window_id: String,
    pub profile_id: String,
    pub channel_id: String,
    pub channel_version: String,
    pub proxy: ProxyBinding,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Launching,
    Running,
    Stopping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchStatus {
    pub snapshot: LaunchSnapshot,
    pub phase: Phase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerError {
    InvalidIdentifier,
    DuplicateChannel,
    ChannelNotFound,
    CapacityUnverified,
    CapacityExhausted,
    WindowBusy,
    ProfileBusy,
    ProfileNotBound,
    ProfileAlreadyBound,
    ProfileEngineMismatch,
    StaleAttempt,
    InvalidTransition,
    GenerationExhausted,
}

#[derive(Default)]
pub struct Scheduler {
    channels: HashMap<String, EngineChannel>,
    profiles: HashMap<String, ProfileBinding>,
    active: HashMap<String, LaunchStatus>,
    generation: u64,
}

impl Scheduler {
    pub fn register_channel(&mut self, channel: EngineChannel) -> Result<(), SchedulerError> {
        if channel.id.trim().is_empty() || channel.version.trim().is_empty() {
            return Err(SchedulerError::InvalidIdentifier);
        }
        if self.channels.contains_key(&channel.id) {
            return Err(SchedulerError::DuplicateChannel);
        }
        self.channels.insert(channel.id.clone(), channel);
        Ok(())
    }

    pub fn set_capacity(
        &mut self,
        channel_id: &str,
        capacity: EngineCapacity,
    ) -> Result<(), SchedulerError> {
        let channel = self
            .channels
            .get_mut(channel_id)
            .ok_or(SchedulerError::ChannelNotFound)?;
        channel.capacity = capacity;
        Ok(())
    }

    // Persist the returned record before restoring it into this scheduler.
    pub fn propose_profile_binding(
        &self,
        profile_id: &str,
        channel_id: &str,
    ) -> Result<ProfileBinding, SchedulerError> {
        if profile_id.trim().is_empty() {
            return Err(SchedulerError::InvalidIdentifier);
        }
        if self.profiles.contains_key(profile_id) {
            return Err(SchedulerError::ProfileAlreadyBound);
        }
        let channel = self
            .channels
            .get(channel_id)
            .ok_or(SchedulerError::ChannelNotFound)?;
        Ok(ProfileBinding {
            profile_id: profile_id.to_owned(),
            channel_id: channel.id.clone(),
            channel_version: channel.version.clone(),
        })
    }

    pub fn restore_profile(&mut self, binding: ProfileBinding) -> Result<(), SchedulerError> {
        if binding.profile_id.trim().is_empty()
            || binding.channel_id.trim().is_empty()
            || binding.channel_version.trim().is_empty()
        {
            return Err(SchedulerError::InvalidIdentifier);
        }
        if self.profiles.contains_key(&binding.profile_id) {
            return Err(SchedulerError::ProfileAlreadyBound);
        }
        self.profiles.insert(binding.profile_id.clone(), binding);
        Ok(())
    }

    pub fn remove_profile(&mut self, profile_id: &str) -> Result<(), SchedulerError> {
        if self
            .active
            .values()
            .any(|state| state.snapshot.profile_id == profile_id)
        {
            return Err(SchedulerError::ProfileBusy);
        }
        self.profiles
            .remove(profile_id)
            .ok_or(SchedulerError::ProfileNotBound)?;
        Ok(())
    }

    pub fn active_count(&self, channel_id: &str) -> usize {
        self.active
            .values()
            .filter(|state| state.snapshot.channel_id == channel_id)
            .count()
    }

    pub fn status(&self, window_id: &str) -> Option<&LaunchStatus> {
        self.active.get(window_id)
    }

    pub fn reserve(&mut self, request: LaunchRequest) -> Result<LaunchSnapshot, SchedulerError> {
        if request.window_id.trim().is_empty()
            || request.profile_id.trim().is_empty()
            || request.channel_id.trim().is_empty()
        {
            return Err(SchedulerError::InvalidIdentifier);
        }
        let channel = self
            .channels
            .get(&request.channel_id)
            .ok_or(SchedulerError::ChannelNotFound)?;
        if self.active.contains_key(&request.window_id) {
            return Err(SchedulerError::WindowBusy);
        }
        if self
            .active
            .values()
            .any(|state| state.snapshot.profile_id == request.profile_id)
        {
            return Err(SchedulerError::ProfileBusy);
        }
        let binding = self
            .profiles
            .get(&request.profile_id)
            .ok_or(SchedulerError::ProfileNotBound)?;
        if binding.channel_id != channel.id || binding.channel_version != channel.version {
            return Err(SchedulerError::ProfileEngineMismatch);
        }
        match channel.capacity {
            EngineCapacity::Unknown => return Err(SchedulerError::CapacityUnverified),
            EngineCapacity::Limited(limit) if self.active_count(&channel.id) >= limit.get() => {
                return Err(SchedulerError::CapacityExhausted);
            }
            EngineCapacity::Limited(_) | EngineCapacity::ProviderEnforced => {}
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(SchedulerError::GenerationExhausted)?;
        self.generation = generation;
        let snapshot = LaunchSnapshot {
            window_id: request.window_id,
            profile_id: request.profile_id,
            channel_id: channel.id.clone(),
            channel_version: channel.version.clone(),
            proxy: request.proxy,
            generation,
        };
        self.active.insert(
            snapshot.window_id.clone(),
            LaunchStatus {
                snapshot: snapshot.clone(),
                phase: Phase::Launching,
            },
        );
        Ok(snapshot)
    }

    pub fn mark_running(&mut self, attempt: &LaunchSnapshot) -> Result<(), SchedulerError> {
        let state = self.current_mut(attempt)?;
        if state.phase != Phase::Launching {
            return Err(SchedulerError::InvalidTransition);
        }
        state.phase = Phase::Running;
        Ok(())
    }

    // Call only after a partially launched browser has been fully cleaned up.
    pub fn start_failed(&mut self, attempt: &LaunchSnapshot) -> Result<(), SchedulerError> {
        if self.current(attempt)?.phase != Phase::Launching {
            return Err(SchedulerError::InvalidTransition);
        }
        self.active.remove(&attempt.window_id);
        Ok(())
    }

    pub fn begin_stop(&mut self, attempt: &LaunchSnapshot) -> Result<(), SchedulerError> {
        let state = self.current_mut(attempt)?;
        if state.phase == Phase::Stopping {
            return Err(SchedulerError::InvalidTransition);
        }
        state.phase = Phase::Stopping;
        Ok(())
    }

    // Keep the profile reserved until the browser process has actually exited.
    pub fn finish_stop(&mut self, attempt: &LaunchSnapshot) -> Result<(), SchedulerError> {
        if self.current(attempt)?.phase != Phase::Stopping {
            return Err(SchedulerError::InvalidTransition);
        }
        self.active.remove(&attempt.window_id);
        Ok(())
    }

    pub fn process_exited(&mut self, attempt: &LaunchSnapshot) -> Result<(), SchedulerError> {
        self.current(attempt)?;
        self.active.remove(&attempt.window_id);
        Ok(())
    }

    fn current(&self, attempt: &LaunchSnapshot) -> Result<&LaunchStatus, SchedulerError> {
        self.active
            .get(&attempt.window_id)
            .filter(|state| state.snapshot == *attempt)
            .ok_or(SchedulerError::StaleAttempt)
    }

    fn current_mut(
        &mut self,
        attempt: &LaunchSnapshot,
    ) -> Result<&mut LaunchStatus, SchedulerError> {
        self.active
            .get_mut(&attempt.window_id)
            .filter(|state| state.snapshot == *attempt)
            .ok_or(SchedulerError::StaleAttempt)
    }
}
