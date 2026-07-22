use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderMode {
    Bundled,
    UvProject,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderInvocation {
    pub program: PathBuf,
    pub arguments: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ProviderRuntime {
    mode: ProviderMode,
    program: PathBuf,
    prefix: Vec<String>,
}

impl ProviderRuntime {
    pub fn discover(
        search_directories: &[PathBuf],
        source_project: PathBuf,
    ) -> anyhow::Result<Self> {
        Self::discover_named(
            search_directories,
            source_project,
            "PROXBOT_PROVIDER",
            "proxbot-ios-provider",
        )
    }

    pub fn discover_proxy(
        search_directories: &[PathBuf],
        source_project: PathBuf,
    ) -> anyhow::Result<Self> {
        Self::discover_named(
            search_directories,
            source_project,
            "PROXBOT_PROXY_PROVIDER",
            "proxbot-proxy-provider",
        )
    }

    fn discover_named(
        search_directories: &[PathBuf],
        source_project: PathBuf,
        environment_variable: &str,
        executable_name: &str,
    ) -> anyhow::Result<Self> {
        if let Some(path) = std::env::var_os(environment_variable) {
            let path = PathBuf::from(path);
            anyhow::ensure!(path.is_file(), "{environment_variable} is not a file");
            return Self::from_executable(path);
        }

        for directory in search_directories {
            let path = directory.join(executable_name);
            if path.is_file() {
                return Self::from_executable(path);
            }
        }

        let uv = [
            std::env::var("PROXBOT_UV").ok(),
            Some("/opt/homebrew/bin/uv".to_owned()),
            Some("/usr/local/bin/uv".to_owned()),
            Some("uv".to_owned()),
        ]
        .into_iter()
        .flatten()
        .find(|candidate| candidate == "uv" || PathBuf::from(candidate).is_file())
        .expect("uv fallback is always present");

        Ok(Self {
            mode: ProviderMode::UvProject,
            program: PathBuf::from(uv),
            prefix: vec![
                "run".into(),
                "--project".into(),
                source_project.display().to_string(),
                executable_name.into(),
            ],
        })
    }

    pub fn from_executable(program: PathBuf) -> anyhow::Result<Self> {
        anyhow::ensure!(program.is_file(), "provider executable is not a file");
        Ok(Self {
            mode: ProviderMode::Bundled,
            program,
            prefix: Vec::new(),
        })
    }

    pub fn mode(&self) -> ProviderMode {
        self.mode
    }

    pub fn invocation(&self, subcommand: &str, arguments: &[&str]) -> ProviderInvocation {
        let mut invocation_arguments = self.prefix.clone();
        invocation_arguments.push(subcommand.to_owned());
        invocation_arguments.extend(arguments.iter().map(|argument| (*argument).to_owned()));
        ProviderInvocation {
            program: self.program.clone(),
            arguments: invocation_arguments,
        }
    }
}
