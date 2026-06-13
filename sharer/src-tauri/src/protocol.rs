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

#[cfg(test)]
mod tests {
    use super::*;

    // Regression guard for the rename documented above: a PeerJoined frame
    // must deserialize whether `country` is present or absent. A wrong/missing
    // rename silently dropped every PeerJoined (the sharer never saw incoming
    // viewers).
    #[test]
    fn peer_joined_deserializes_with_country_present() {
        let json = r#"{"type":"peer-joined","viewerInfo":{"ipPrefix":"84.xxx","country":"DE"}}"#;
        match serde_json::from_str::<Incoming>(json).expect("parse") {
            Incoming::PeerJoined { viewer_info } => {
                assert_eq!(viewer_info.ip_prefix, "84.xxx");
                assert_eq!(viewer_info._country.as_deref(), Some("DE"));
            }
            other => panic!("expected PeerJoined, got {other:?}"),
        }
    }

    #[test]
    fn peer_joined_deserializes_with_country_null_or_absent() {
        for json in [
            r#"{"type":"peer-joined","viewerInfo":{"ipPrefix":"10.xxx","country":null}}"#,
            r#"{"type":"peer-joined","viewerInfo":{"ipPrefix":"10.xxx"}}"#,
        ] {
            match serde_json::from_str::<Incoming>(json).expect("parse") {
                Incoming::PeerJoined { viewer_info } => {
                    assert_eq!(viewer_info.ip_prefix, "10.xxx");
                    assert_eq!(viewer_info._country, None);
                }
                other => panic!("expected PeerJoined, got {other:?}"),
            }
        }
    }
}
