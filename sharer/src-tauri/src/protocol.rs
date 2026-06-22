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
        expires_in_sec: u64,
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
    // `#[serde(default)]` so an absent `country` key (older backends that
    // never send it) doesn't fail the whole struct and silently drop every
    // PeerJoined frame.
    #[serde(rename = "country", default)]
    pub country: Option<String>,
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
                assert_eq!(viewer_info.country.as_deref(), Some("DE"));
            }
            other => panic!("expected PeerJoined, got {other:?}"),
        }
    }

    // The sharer surfaces the code's time-to-live as a countdown, so the
    // backend-stamped expiresInSec must survive deserialization (it was
    // previously parsed into a discarded `_expires_in_sec` field).
    #[test]
    fn code_assigned_deserializes_expires_in_sec() {
        let json = r#"{"type":"code-assigned","code":"123456789","expiresInSec":600}"#;
        match serde_json::from_str::<Incoming>(json).expect("parse") {
            Incoming::CodeAssigned {
                code,
                expires_in_sec,
            } => {
                assert_eq!(code, "123456789");
                assert_eq!(expires_in_sec, 600);
            }
            other => panic!("expected CodeAssigned, got {other:?}"),
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
                    assert_eq!(viewer_info.country, None);
                }
                other => panic!("expected PeerJoined, got {other:?}"),
            }
        }
    }
}
