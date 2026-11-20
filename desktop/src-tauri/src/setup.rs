use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};

use crate::{Mode, Paths};

const PYTHON_VERSION: &str = "3.12";

pub fn provision<F>(paths: &Paths, mut progress: F) -> Result<Paths>
where
    F: FnMut(&str),
{
    progress("Ensuring Python 3.12 is installed");
    run(&paths.uv_bin, &["python", "install", PYTHON_VERSION], None, &[])
        .context("uv python install failed")?;

    match paths.mode {
        Mode::Dev => provision_dev(paths, &mut progress)?,
        Mode::Bundled => provision_bundled(paths, &mut progress)?,
    }

    if !paths.python_bin.exists() {
        bail!("venv python missing after provision: {}", paths.python_bin.display());
    }

    progress("Python environment ready");
    Ok(paths.clone())
}

fn provision_dev<F: FnMut(&str)>(paths: &Paths, progress: &mut F) -> Result<()> {
    // Dev mode: drive the venv from the live server/pyproject.toml so a
    // change to a dep is reflected on next launch without rebuilding wheels.
    // Editable installs of sdk + gat + gridsight-gat come from the sibling
    // repos via [tool.uv.sources].
    if !paths.server_dir.exists() {
        bail!("server dir missing: {}", paths.server_dir.display());
    }
    progress("Syncing Python environment from server/pyproject.toml");
    let env = [(
        "UV_PROJECT_ENVIRONMENT".to_string(),
        paths.venv_dir.to_string_lossy().into_owned(),
    )];
    run(
        &paths.uv_bin,
        &[
            "sync",
            "--project",
            paths.server_dir.to_str().context("server path not utf-8")?,
            "--no-dev",
            "--python",
            PYTHON_VERSION,
        ],
        None,
        &env,
    )
    .context("uv sync against server/pyproject.toml failed")
}

fn provision_bundled<F: FnMut(&str)>(paths: &Paths, progress: &mut F) -> Result<()> {
    // Bundled mode: the .app/.exe ships a frozen server tree, a generated
    // requirements.txt, and pre-built wheels for gridsight-sdk + gridsight-seds.
    // The target machine has no copy of the repo and no live source.
    let req = paths.requirements.as_ref().context("bundled requirements path")?;
    let wheels = paths.wheels_dir.as_ref().context("bundled wheels path")?;

    if !paths.venv_dir.exists() {
        progress("Creating virtual environment");
        run(
            &paths.uv_bin,
            &[
                "venv",
                "--python",
                PYTHON_VERSION,
                paths.venv_dir.to_str().context("venv path not utf-8")?,
            ],
            None,
            &[],
        )
        .context("uv venv failed")?;
    }

    progress("Installing PyPI dependencies");
    run(
        &paths.uv_bin,
        &[
            "pip",
            "install",
            "--python",
            paths.python_bin.to_str().context("python path not utf-8")?,
            "-r",
            req.to_str().context("requirements path not utf-8")?,
        ],
        None,
        &[],
    )
    .context("uv pip install -r requirements.txt failed")?;

    let mut wheel_paths: Vec<String> = std::fs::read_dir(wheels)
        .with_context(|| format!("read {}", wheels.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("whl"))
        .filter_map(|p| p.to_str().map(String::from))
        .collect();
    wheel_paths.sort();
    if wheel_paths.is_empty() {
        log::warn!("no wheels found in {} — skipping extension install", wheels.display());
        return Ok(());
    }
    progress(&format!("Installing {} bundled wheels", wheel_paths.len()));
    let mut args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--python".to_string(),
        paths.python_bin.to_string_lossy().into_owned(),
        "--force-reinstall".to_string(),
        "--no-deps".to_string(),
    ];
    args.extend(wheel_paths);
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run(&paths.uv_bin, &argrefs, None, &[]).context("uv pip install wheels failed")?;

    Ok(())
}

fn run(bin: &Path, args: &[&str], cwd: Option<&Path>, env: &[(String, String)]) -> Result<()> {
    log::info!("$ {} {}", bin.display(), args.join(" "));
    let mut cmd = Command::new(bin);
    cmd.args(args).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    for (k, v) in env {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let status = cmd.status().with_context(|| format!("spawn {}", bin.display()))?;
    if !status.success() {
        bail!("{} {} exited with {}", bin.display(), args.join(" "), status);
    }
    Ok(())
}
