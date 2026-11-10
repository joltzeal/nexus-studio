use super::provider::{BrowserError, BrowserProvider, BrowserProviderId, BrowserResult};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
pub struct ProviderRegistry {
    providers: HashMap<BrowserProviderId, Arc<dyn BrowserProvider>>,
}
impl ProviderRegistry {
    pub fn register(&mut self, provider: Arc<dyn BrowserProvider>) {
        self.providers.insert(provider.id(), provider);
    }
    pub fn get(&self, id: BrowserProviderId) -> BrowserResult<Arc<dyn BrowserProvider>> {
        self.providers
            .get(&id)
            .cloned()
            .ok_or_else(|| BrowserError::unsupported("此浏览器尚未接入"))
    }
}
