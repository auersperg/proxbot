use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Created,
    Preparing,
    Capturing,
    Degraded,
    Stopping,
    Finalizing,
    Ready,
    Corrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderState {
    Registered,
    Ready,
    Capturing,
    Degraded,
    Stopped,
    Failed,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("invalid session transition: {from:?} cannot {action}")]
    InvalidTransition {
        from: SessionStatus,
        action: &'static str,
    },
    #[error("provider already registered: {0}")]
    DuplicateProvider(String),
    #[error("unknown provider: {0}")]
    UnknownProvider(String),
}

pub struct SessionCoordinator {
    id: Uuid,
    status: SessionStatus,
    providers: BTreeMap<String, ProviderState>,
}

impl SessionCoordinator {
    pub fn new(id: Uuid) -> Self {
        Self {
            id,
            status: SessionStatus::Created,
            providers: BTreeMap::new(),
        }
    }

    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn status(&self) -> SessionStatus {
        self.status
    }

    pub fn providers(&self) -> &BTreeMap<String, ProviderState> {
        &self.providers
    }

    pub fn register_provider(&mut self, id: impl Into<String>) -> Result<(), SessionError> {
        let id = id.into();
        if self
            .providers
            .insert(id.clone(), ProviderState::Registered)
            .is_some()
        {
            return Err(SessionError::DuplicateProvider(id));
        }
        Ok(())
    }

    pub fn prepare(&mut self) -> Result<(), SessionError> {
        self.require(SessionStatus::Created, "prepare")?;
        self.status = SessionStatus::Preparing;
        for state in self.providers.values_mut() {
            *state = ProviderState::Ready;
        }
        Ok(())
    }

    pub fn start(&mut self) -> Result<(), SessionError> {
        self.require(SessionStatus::Preparing, "start")?;
        self.status = SessionStatus::Capturing;
        for state in self.providers.values_mut() {
            *state = ProviderState::Capturing;
        }
        Ok(())
    }

    pub fn set_provider_state(
        &mut self,
        id: &str,
        state: ProviderState,
    ) -> Result<(), SessionError> {
        let slot = self
            .providers
            .get_mut(id)
            .ok_or_else(|| SessionError::UnknownProvider(id.to_owned()))?;
        *slot = state;
        if matches!(state, ProviderState::Degraded | ProviderState::Failed)
            && matches!(
                self.status,
                SessionStatus::Capturing | SessionStatus::Degraded
            )
        {
            self.status = SessionStatus::Degraded;
        }
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), SessionError> {
        if !matches!(
            self.status,
            SessionStatus::Capturing | SessionStatus::Degraded
        ) {
            return Err(SessionError::InvalidTransition {
                from: self.status,
                action: "stop",
            });
        }
        self.status = SessionStatus::Stopping;
        for state in self.providers.values_mut() {
            *state = ProviderState::Stopped;
        }
        self.status = SessionStatus::Finalizing;
        Ok(())
    }

    pub fn finalize(&mut self) -> Result<(), SessionError> {
        self.require(SessionStatus::Finalizing, "finalize")?;
        self.status = SessionStatus::Ready;
        Ok(())
    }

    fn require(&self, expected: SessionStatus, action: &'static str) -> Result<(), SessionError> {
        if self.status == expected {
            Ok(())
        } else {
            Err(SessionError::InvalidTransition {
                from: self.status,
                action,
            })
        }
    }
}
