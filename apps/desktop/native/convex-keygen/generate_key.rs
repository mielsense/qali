use std::io::{self, Read};

use anyhow::bail;
use common::types::MemberId;
use keybroker::{DeploymentSecret, KeyBroker};
use serde::Deserialize;

const MAX_REQUEST_BYTES: u64 = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    instance_name: String,
    instance_secret: String,
}

fn main() -> anyhow::Result<()> {
    if std::env::args_os().nth(1).is_some() {
        bail!("The Qali key generator accepts credentials only over stdin");
    }

    let mut input = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        input.fill(0);
        bail!("Key-generator request exceeded its size limit");
    }
    let parsed_request = serde_json::from_slice(&input);
    input.fill(0);
    let request: Request = parsed_request?;

    let deployment_secret = DeploymentSecret::try_from(request.instance_secret.as_str())?;
    let broker = KeyBroker::new(&request.instance_name, deployment_secret)?;
    let admin_key = broker.issue_admin_key(MemberId(0));
    println!("{}", admin_key.as_str());
    Ok(())
}
