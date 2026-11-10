use super::browser::provider::{BrowserBinding, WindowState};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyBinding {
    Direct,
    Provider,
    /// Restored occupancy; this snapshot never authorizes a new launch.
    Observed,
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
    pub binding: BrowserBinding,
    pub proxy: ProxyBinding,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSnapshot {
    pub window_id: String,
    pub binding: BrowserBinding,
    pub proxy: ProxyBinding,
    pub generation: u64,
}
#[derive(Debug, Clone)]
pub struct LaunchStatus {
    pub snapshot: LaunchSnapshot,
    pub state: WindowState,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerError {
    InvalidIdentifier,
    WindowBusy,
    ProfileBusy,
    StaleAttempt,
    GenerationExhausted,
}
#[derive(Default)]
pub struct Scheduler {
    active: HashMap<String, LaunchStatus>,
    generation: u64,
}
impl Scheduler {
    pub fn reserve(&mut self, request: LaunchRequest) -> Result<LaunchSnapshot, SchedulerError> {
        if request.window_id.is_empty()
            || request.binding.connection_id.is_empty()
            || request.binding.profile_id.is_empty()
        {
            return Err(SchedulerError::InvalidIdentifier);
        }
        if self.active.contains_key(&request.window_id) {
            return Err(SchedulerError::WindowBusy);
        }
        if self
            .active
            .values()
            .any(|state| state.snapshot.binding == request.binding)
        {
            return Err(SchedulerError::ProfileBusy);
        }
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or(SchedulerError::GenerationExhausted)?;
        let snapshot = LaunchSnapshot {
            window_id: request.window_id,
            binding: request.binding,
            proxy: request.proxy,
            generation: self.generation,
        };
        self.active.insert(
            snapshot.window_id.clone(),
            LaunchStatus {
                snapshot: snapshot.clone(),
                state: WindowState::Starting,
            },
        );
        Ok(snapshot)
    }
    pub fn status(&self, id: &str) -> Option<&LaunchStatus> {
        self.active.get(id)
    }
    pub fn is_idle(&self) -> bool {
        self.active.is_empty()
    }
    pub fn has_active_provider(
        &self,
        provider: super::browser::provider::BrowserProviderId,
    ) -> bool {
        self.active
            .values()
            .any(|status| status.snapshot.binding.provider_id == provider)
    }
    pub fn confirm_running(&mut self, snapshot: &LaunchSnapshot) -> Result<(), SchedulerError> {
        self.current(snapshot)?;
        self.active
            .get_mut(&snapshot.window_id)
            .ok_or(SchedulerError::StaleAttempt)?
            .state = WindowState::Running;
        Ok(())
    }
    pub fn begin_stop(&mut self, snapshot: &LaunchSnapshot) -> Result<(), SchedulerError> {
        self.current(snapshot)?;
        self.active
            .get_mut(&snapshot.window_id)
            .ok_or(SchedulerError::StaleAttempt)?
            .state = WindowState::Stopping;
        Ok(())
    }
    pub fn uncertain(&mut self, snapshot: &LaunchSnapshot) -> Result<(), SchedulerError> {
        self.current(snapshot)?;
        self.active
            .get_mut(&snapshot.window_id)
            .ok_or(SchedulerError::StaleAttempt)?
            .state = WindowState::Unknown;
        Ok(())
    }
    pub fn release(&mut self, snapshot: &LaunchSnapshot) -> Result<(), SchedulerError> {
        self.current(snapshot)?;
        self.active.remove(&snapshot.window_id);
        Ok(())
    }
    fn current(&self, snapshot: &LaunchSnapshot) -> Result<(), SchedulerError> {
        self.active
            .get(&snapshot.window_id)
            .filter(|state| state.snapshot == *snapshot)
            .map(|_| ())
            .ok_or(SchedulerError::StaleAttempt)
    }
}
