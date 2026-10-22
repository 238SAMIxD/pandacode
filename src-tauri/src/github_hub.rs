//! The GitHub view: the signed-in account's repositories and each repository's open pull
//! requests and issues, read by `owner/name` so a repository needs no local checkout to
//! browse. Local projects are matched to repositories by their `origin` remote, and a
//! repository can be cloned into a folder the user picks. Everything goes through `gh`
//! with bounded output and a deadline (`workspace::run_process`); user text reaches `gh`
//! only as validated arguments.
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use crate::github::{json, names, run_gh, state_of, text, TIMEOUT};
use crate::workspace::{checked, run_process};

const LIST_LIMIT: &str = "50";
const CLONE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubRepo {
    pub name_with_owner: String,
    pub description: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub pushed_at: String,
    pub url: String,
    pub default_branch: String,
    pub open_issues: i64,
    pub language: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPull {
    pub number: i64,
    pub title: String,
    pub author: String,
    pub state: String,
    pub head: String,
    pub base: String,
    pub updated_at: String,
    pub url: String,
    pub review: String,
    pub checks: String,
    pub additions: i64,
    pub deletions: i64,
    pub labels: Vec<String>,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubIssue {
    pub number: i64,
    pub title: String,
    pub author: String,
    pub updated_at: String,
    pub url: String,
    pub comments: i64,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubRun {
    pub id: i64,
    pub workflow: String,
    pub title: String,
    pub branch: String,
    pub event: String,
    /// queued, in_progress, passed, failed, not_started or cancelled (`run_state`).
    pub state: String,
    pub created_at: String,
    pub started_at: String,
    pub updated_at: String,
    pub url: String,
    /// How many times the run was attempted; re-runs count up from 1.
    pub attempt: i64,
    /// Pull requests in this repository the run's head belongs to (empty for forks).
    pub pulls: Vec<i64>,
}
/// A run's jobs and uploaded artifacts, read when its row is expanded.
#[derive(Debug, Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunDetails {
    pub jobs: Vec<RunJob>,
    pub artifacts: Vec<RunArtifact>,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunJob {
    pub name: String,
    pub state: String,
    pub started_at: String,
    pub completed_at: String,
    pub url: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunArtifact {
    pub name: String,
    pub size: i64,
    pub expired: bool,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    pub project_id: String,
    pub repo: String,
}

/// `owner/name` as GitHub allows it, never an option or a path.
pub fn valid_repo(value: &str) -> Result<String, String> {
    let value = value.trim();
    let part = |s: &str| !s.is_empty() && s.len() <= 100 && !s.starts_with(['-', '.']) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    match value.split_once('/') {
        Some((owner, name)) if part(owner) && part(name) && !name.contains('/') && name != ".." => Ok(value.to_string()),
        _ => Err("Choose a GitHub repository (owner/name).".into()),
    }
}

/// The `owner/name` a GitHub remote URL points at, for HTTPS, SSH and scp-style remotes.
pub fn repo_from_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git://github.com/"))?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    valid_repo(path).ok()
}

fn account_root() -> PathBuf {
    crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir)
}

fn repo_of(value: &serde_json::Value) -> HubRepo {
    HubRepo {
        name_with_owner: text(value, "full_name"),
        description: text(value, "description"),
        private: value.get("private").and_then(|v| v.as_bool()).unwrap_or(false),
        fork: value.get("fork").and_then(|v| v.as_bool()).unwrap_or(false),
        archived: value.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
        pushed_at: text(value, "pushed_at"),
        url: text(value, "html_url"),
        default_branch: text(value, "default_branch"),
        open_issues: value.get("open_issues_count").and_then(|v| v.as_i64()).unwrap_or(0),
        language: text(value, "language"),
    }
}

/// Repositories the account owns, collaborates on or reaches through an organization,
/// most recently pushed first.
pub fn repos() -> Result<Vec<HubRepo>, String> {
    let capture = run_gh(&account_root(), &["api", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"], TIMEOUT)?;
    let value = json(&capture)?;
    let items = value.as_array().ok_or("GitHub returned an unexpected response.")?;
    Ok(items.iter().map(repo_of).filter(|repo| valid_repo(&repo.name_with_owner).is_ok()).collect())
}

/// One word for a pull request's checks: passing, failing, pending or none.
pub fn checks_summary(rollup: Option<&serde_json::Value>) -> String {
    let Some(items) = rollup.and_then(|v| v.as_array()) else { return "none".into() };
    if items.is_empty() {
        return "none".into();
    }
    let outcome = |item: &serde_json::Value| text(item, "conclusion").to_ascii_uppercase() + &text(item, "state").to_ascii_uppercase();
    let outcomes: Vec<String> = items.iter().map(outcome).collect();
    if outcomes.iter().any(|o| ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].iter().any(|bad| o.contains(bad))) {
        "failing".into()
    } else if outcomes.iter().any(|o| o.is_empty() || ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].iter().any(|wait| o.contains(wait))) {
        "pending".into()
    } else {
        "passing".into()
    }
}

fn author(value: &serde_json::Value) -> String {
    value.get("author").map(|author| text(author, "login")).unwrap_or_default()
}

pub fn pulls(repo: &str) -> Result<Vec<HubPull>, String> {
    let repo = valid_repo(repo)?;
    let fields = "number,title,author,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup,additions,deletions,labels";
    let capture = run_gh(&account_root(), &["pr", "list", &format!("--repo={repo}"), "--state=open", &format!("--limit={LIST_LIMIT}"), &format!("--json={fields}")], TIMEOUT)?;
    let value = json(&capture)?;
    let items = value.as_array().ok_or("GitHub returned an unexpected response.")?;
    Ok(items
        .iter()
        .map(|item| HubPull {
            number: item.get("number").and_then(|v| v.as_i64()).unwrap_or_default(),
            title: text(item, "title"),
            author: author(item),
            state: state_of(item),
            head: text(item, "headRefName"),
            base: text(item, "baseRefName"),
            updated_at: text(item, "updatedAt"),
            url: text(item, "url"),
            review: text(item, "reviewDecision").to_ascii_lowercase(),
            checks: checks_summary(item.get("statusCheckRollup")),
            additions: item.get("additions").and_then(|v| v.as_i64()).unwrap_or_default(),
            deletions: item.get("deletions").and_then(|v| v.as_i64()).unwrap_or_default(),
            labels: names(item, "labels", "name"),
        })
        .collect())
}

pub fn issues(repo: &str) -> Result<Vec<HubIssue>, String> {
    let repo = valid_repo(repo)?;
    let capture = run_gh(&account_root(), &["issue", "list", &format!("--repo={repo}"), "--state=open", &format!("--limit={LIST_LIMIT}"), "--json=number,title,author,updatedAt,url,comments,labels,assignees"], TIMEOUT)?;
    let value = json(&capture)?;
    let items = value.as_array().ok_or("GitHub returned an unexpected response.")?;
    Ok(items
        .iter()
        .map(|item| HubIssue {
            number: item.get("number").and_then(|v| v.as_i64()).unwrap_or_default(),
            title: text(item, "title"),
            author: author(item),
            updated_at: text(item, "updatedAt"),
            url: text(item, "url"),
            comments: item.get("comments").and_then(|v| v.as_array()).map_or(0, |c| c.len() as i64),
            labels: names(item, "labels", "name"),
            assignees: names(item, "assignees", "login"),
        })
        .collect())
}

/// One word for a workflow run or job from its status and conclusion. A run that never
/// started (an invalid workflow file, a missing runner) is `not_started`, not a failure to fix in code.
pub fn run_state(status: &str, conclusion: &str) -> String {
    match (status.to_ascii_lowercase().as_str(), conclusion.to_ascii_lowercase().as_str()) {
        ("completed", "success" | "neutral" | "skipped") => "passed",
        ("completed", "cancelled") => "cancelled",
        ("completed", "startup_failure") => "not_started",
        ("completed", _) => "failed",
        ("in_progress", _) => "in_progress",
        _ => "queued",
    }
    .into()
}

fn number(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or_default()
}
fn list<'a>(value: &'a serde_json::Value, key: &str) -> &'a [serde_json::Value] {
    value.get(key).and_then(|v| v.as_array()).map_or(&[], |items| items.as_slice())
}

/// Runs from the REST `actions/runs` response.
pub fn runs_of(value: &serde_json::Value) -> Vec<HubRun> {
    list(value, "workflow_runs")
        .iter()
        .map(|item| HubRun {
            id: number(item, "id"),
            workflow: text(item, "name"),
            title: text(item, "display_title"),
            branch: text(item, "head_branch"),
            event: text(item, "event"),
            state: run_state(&text(item, "status"), &text(item, "conclusion")),
            created_at: text(item, "created_at"),
            started_at: text(item, "run_started_at"),
            updated_at: text(item, "updated_at"),
            url: text(item, "html_url"),
            attempt: number(item, "run_attempt").max(1),
            pulls: list(item, "pull_requests").iter().map(|pull| number(pull, "number")).filter(|n| *n > 0).collect(),
        })
        .collect()
}

/// The repository's most recent workflow runs, newest first.
pub fn runs(repo: &str) -> Result<Vec<HubRun>, String> {
    let repo = valid_repo(repo)?;
    let capture = run_gh(&account_root(), &["api", &format!("repos/{repo}/actions/runs?per_page={LIST_LIMIT}")], TIMEOUT)?;
    Ok(runs_of(&json(&capture)?))
}

/// Jobs (latest attempt) and artifacts from the REST `jobs` and `artifacts` responses.
pub fn details_of(jobs: &serde_json::Value, artifacts: &serde_json::Value) -> RunDetails {
    RunDetails {
        jobs: list(jobs, "jobs")
            .iter()
            .map(|job| RunJob {
                name: text(job, "name"),
                state: run_state(&text(job, "status"), &text(job, "conclusion")),
                started_at: text(job, "started_at"),
                completed_at: text(job, "completed_at"),
                url: text(job, "html_url"),
            })
            .collect(),
        artifacts: list(artifacts, "artifacts")
            .iter()
            .map(|artifact| RunArtifact { name: text(artifact, "name"), size: number(artifact, "size_in_bytes"), expired: artifact.get("expired").and_then(|v| v.as_bool()).unwrap_or(false) })
            .collect(),
    }
}

pub fn run_details(repo: &str, id: i64) -> Result<RunDetails, String> {
    let repo = valid_repo(repo)?;
    if id <= 0 {
        return Err("Choose a workflow run.".into());
    }
    let root = account_root();
    let jobs = json(&run_gh(&root, &["api", &format!("repos/{repo}/actions/runs/{id}/jobs?per_page=100")], TIMEOUT)?)?;
    let artifacts = json(&run_gh(&root, &["api", &format!("repos/{repo}/actions/runs/{id}/artifacts?per_page=100")], TIMEOUT)?)?;
    Ok(details_of(&jobs, &artifacts))
}

/// The GitHub repository behind a local project, from its `origin` remote.
pub fn project_repo(root: &Path) -> Option<String> {
    let mut command = Command::new("git");
    command.current_dir(root).args(["config", "--get", "remote.origin.url"]);
    let output = checked(run_process(command, "Git", 4 * 1024, Duration::from_secs(5)).ok()?).ok()?;
    repo_from_remote(&String::from_utf8_lossy(&output.bytes))
}

/// Where a clone of `repo` lands inside `parent`, refusing anything that already exists.
pub fn clone_destination(parent: &Path, repo: &str) -> Result<PathBuf, String> {
    let repo = valid_repo(repo)?;
    if !parent.is_absolute() || !parent.is_dir() {
        return Err("Choose an existing folder to clone into.".into());
    }
    let name = repo.split_once('/').map(|(_, name)| name).unwrap_or(&repo);
    let destination = parent.join(name);
    if destination.exists() {
        return Err(format!("{} already exists. Open it as a project instead, or choose another folder.", destination.display()));
    }
    Ok(destination)
}

pub fn clone(repo: &str, parent: &Path) -> Result<PathBuf, String> {
    let destination = clone_destination(parent, repo)?;
    clone_to(repo, &destination, CLONE_TIMEOUT)?;
    Ok(destination)
}

/// Clones `repo` into `destination`, whose parent must exist and which must not.
pub fn clone_to(repo: &str, destination: &Path, timeout: Duration) -> Result<(), String> {
    let repo = valid_repo(repo)?;
    let parent = destination.parent().filter(|parent| parent.is_dir()).ok_or("Choose an existing folder to clone into.")?;
    let target = destination.to_string_lossy().to_string();
    run_gh(parent, &["repo", "clone", &repo, &target], timeout)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Live: lists the signed-in account's repositories. Run it with a Finder-like
    /// environment (`env -i HOME=$HOME PATH=/usr/bin:/bin <test binary> --ignored`) to
    /// check that `gh` is found without the shell's PATH.
    #[test]
    #[ignore]
    fn live_lists_repositories_from_a_minimal_path() {
        let list = repos().expect("gh lists repositories");
        assert!(!list.is_empty());
        assert!(list.iter().all(|repo| valid_repo(&repo.name_with_owner).is_ok()));
    }

    #[test]
    fn repositories_must_be_owner_and_name() {
        assert_eq!(valid_repo(" orbit-labs/orbit ").unwrap(), "orbit-labs/orbit");
        assert!(valid_repo("orbit").is_err());
        assert!(valid_repo("--repo=x/y").is_err());
        assert!(valid_repo("owner/../etc").is_err());
        assert!(valid_repo("owner/name/extra").is_err());
        assert!(valid_repo("owner/.hidden").is_err());
        assert!(valid_repo("own er/name").is_err());
    }

    #[test]
    fn remotes_name_their_repository() {
        for url in ["git@github.com:orbit-labs/orbit.git", "https://github.com/orbit-labs/orbit", "https://github.com/orbit-labs/orbit.git/", "ssh://git@github.com/orbit-labs/orbit.git"] {
            assert_eq!(repo_from_remote(url).as_deref(), Some("orbit-labs/orbit"), "{url}");
        }
        assert_eq!(repo_from_remote("https://gitlab.com/orbit-labs/orbit.git"), None);
        assert_eq!(repo_from_remote("git@github.com:orbit-labs"), None);
    }

    #[test]
    fn checks_fold_into_one_word() {
        assert_eq!(checks_summary(None), "none");
        assert_eq!(checks_summary(Some(&json!([]))), "none");
        assert_eq!(checks_summary(Some(&json!([{ "conclusion": "SUCCESS" }, { "state": "SUCCESS" }]))), "passing");
        assert_eq!(checks_summary(Some(&json!([{ "conclusion": "SUCCESS" }, { "status": "IN_PROGRESS", "conclusion": "" }]))), "pending");
        assert_eq!(checks_summary(Some(&json!([{ "conclusion": "FAILURE" }, { "state": "PENDING" }]))), "failing");
    }

    #[test]
    fn runs_fold_into_one_state() {
        assert_eq!(run_state("completed", "success"), "passed");
        assert_eq!(run_state("completed", "skipped"), "passed");
        assert_eq!(run_state("completed", "failure"), "failed");
        assert_eq!(run_state("completed", "startup_failure"), "not_started");
        assert_eq!(run_state("completed", "cancelled"), "cancelled");
        assert_eq!(run_state("in_progress", ""), "in_progress");
        assert_eq!(run_state("queued", ""), "queued");
        assert_eq!(run_state("waiting", ""), "queued");
    }

    #[test]
    fn runs_carry_their_pull_requests_attempts_and_timing() {
        let value = json!({ "total_count": 2, "workflow_runs": [
            { "id": 9087, "name": "CI", "display_title": "Fix contrast", "head_branch": "devon/contrast", "event": "pull_request", "status": "completed", "conclusion": "failure",
              "created_at": "2026-10-20T10:00:00Z", "run_started_at": "2026-10-20T10:01:00Z", "updated_at": "2026-10-20T10:05:30Z", "html_url": "https://github.com/o/r/actions/runs/9087",
              "run_attempt": 2, "pull_requests": [{ "number": 124, "head": { "ref": "devon/contrast" } }] },
            { "id": 9001, "name": ".github/workflows/bad.yml", "display_title": "push", "head_branch": "main", "event": "push", "status": "completed", "conclusion": "startup_failure", "pull_requests": [] }
        ]});
        let runs = runs_of(&value);
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].attempt, runs[0].pulls.clone(), runs[0].state.as_str(), runs[0].started_at.as_str()), (2, vec![124], "failed", "2026-10-20T10:01:00Z"));
        assert_eq!((runs[1].attempt, runs[1].pulls.len(), runs[1].state.as_str()), (1, 0, "not_started"));
        assert!(runs_of(&json!({})).is_empty());
    }

    #[test]
    fn run_details_list_jobs_and_artifacts() {
        let jobs = json!({ "jobs": [{ "name": "test", "status": "completed", "conclusion": "success", "started_at": "a", "completed_at": "b", "html_url": "u" }, { "name": "lint", "status": "in_progress", "conclusion": null }] });
        let artifacts = json!({ "artifacts": [{ "name": "coverage", "size_in_bytes": 2048, "expired": false }, { "name": "old", "size_in_bytes": 1, "expired": true }] });
        let details = details_of(&jobs, &artifacts);
        assert_eq!(details.jobs.iter().map(|job| (job.name.as_str(), job.state.as_str())).collect::<Vec<_>>(), [("test", "passed"), ("lint", "in_progress")]);
        assert_eq!(details.artifacts[0], RunArtifact { name: "coverage".into(), size: 2048, expired: false });
        assert!(details.artifacts[1].expired);
        assert_eq!(details_of(&json!({}), &json!({})), RunDetails::default());
        assert!(run_details("orbit-labs/orbit", 0).is_err());
        assert!(run_details("--x", 1).is_err());
    }

    #[test]
    fn clones_never_overwrite() {
        let parent = std::env::temp_dir().join(format!("pandacode-clone-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(parent.join("orbit")).unwrap();
        assert!(clone_destination(&parent, "orbit-labs/orbit").unwrap_err().contains("already exists"));
        assert_eq!(clone_destination(&parent, "orbit-labs/meadow").unwrap(), parent.join("meadow"));
        assert!(clone_destination(Path::new("relative"), "orbit-labs/meadow").is_err());
        std::fs::remove_dir_all(parent).unwrap();
    }
}
