use std::{fs, path::PathBuf};

use proxbot_lib::provider::{ProviderMode, ProviderRuntime};
use tempfile::tempdir;

#[test]
fn bundled_provider_is_preferred_and_has_no_uv_prefix() {
    let directory = tempdir().unwrap();
    let executable = directory.path().join("proxbot-ios-provider");
    fs::write(&executable, b"fixture").unwrap();

    let runtime = ProviderRuntime::discover(
        &[directory.path().to_path_buf()],
        PathBuf::from("/source/provider"),
    )
    .unwrap();
    let invocation = runtime.invocation("frida-preflight", &[]);

    assert_eq!(runtime.mode(), ProviderMode::Bundled);
    assert_eq!(invocation.program, executable);
    assert_eq!(invocation.arguments, ["frida-preflight"]);
}

#[test]
fn source_checkout_uses_uv_with_an_explicit_project() {
    let project = PathBuf::from("/source/provider");
    let runtime = ProviderRuntime::discover(&[], project.clone()).unwrap();
    let invocation = runtime.invocation("fake", &["--count", "3"]);

    assert_eq!(runtime.mode(), ProviderMode::UvProject);
    assert_eq!(
        invocation.arguments,
        [
            "run",
            "--project",
            project.to_str().unwrap(),
            "proxbot-ios-provider",
            "fake",
            "--count",
            "3",
        ]
    );
}
