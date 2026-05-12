use serde::{Deserialize, Serialize};

#[derive(Serialize, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Outgoing {
    Register { role: &'static str },
    Confirm { accepted: bool },
    Relay { payload: serde_json::Value },
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Incoming {
    CodeAssigned {
        code: String,
        #[serde(rename = "expiresInSec")]
        _expires_in_sec: u64,
    },
    PeerJoined {
        #[serde(rename = "viewerInfo")]
        viewer_info: ViewerInfo,
    },
    PeerConfirmed,
    PeerRejected {
        reason: String,
    },
    Relay {
        payload: serde_json::Value,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Deserialize, Debug)]
pub struct ViewerInfo {
    #[serde(rename = "ipPrefix")]
    pub ip_prefix: String,
    // The backend sends `country: null` today; we deserialize but ignore
    // it. Without the rename, serde looked for the literal "_country"
    // key in JSON and failed the whole struct (Option<T> without
    // #[serde(default)] is still required) — which silently dropped
    // every PeerJoined message.
    #[serde(rename = "country", default)]
    pub _country: Option<String>,
}
