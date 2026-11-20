//! Custom URI scheme protocol that proxies `meridian-api://localhost/api/*`
//! to the sidecar's HTTP endpoint.
//!
//! The webview's React app uses the same relative `/api/...` URLs the Bun-
//! proxy web mode does, but the bridge rewrites them to absolute
//! `meridian-api://...` URLs. The browser dispatches those to this handler,
//! which makes a Rust-side HTTPS request to the sidecar via reqwest, then
//! returns the response. No CORS, no Vite, no plugin scopes — same scheme
//! works in dev and packaged builds.

use std::time::Duration;

use anyhow::Context as _;
use http::header::{HeaderMap, HeaderName, HeaderValue};
use http::{Response, StatusCode};
use tauri::http::Request;
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder};

use crate::{AppState, BackendStatus, DESKTOP_API_KEY};

pub const SCHEME: &str = "meridian-api";

pub fn handle<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // Preflight requests don't need to reach the sidecar — answer them
    // here. Avoids two issues: (1) the webview may not forward Origin
    // through a custom URI scheme, which makes FastAPI's CORS middleware
    // emit nothing, and (2) the sidecar's OPTIONS handling occasionally
    // 500s on routes that don't explicitly declare OPTIONS support.
    // Capture the request's Origin (if any) before consuming the request,
    // so we can echo it back on responses. ``Allow-Origin: *`` is invalid
    // when the client sets ``xhr.withCredentials = true`` (or fetch
    // ``credentials: 'include'``) — WebKit accepts the bytes but then
    // refuses to surface them to the XHR, which fires ``error`` with
    // status 0. Echoing the origin and setting ``Allow-Credentials: true``
    // is the standard pattern.
    let origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if request.method().as_str().eq_ignore_ascii_case("OPTIONS") {
        responder.respond(preflight_response(origin.as_deref()));
        return;
    }

    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let response = match proxy(&app, request).await {
            Ok(r) => with_cors(r, origin.as_deref()),
            Err(e) => {
                log::error!("meridian-api proxy error: {e:#}");
                with_cors(error_response(StatusCode::BAD_GATEWAY, &format!("{e:#}")), origin.as_deref())
            }
        };
        responder.respond(response);
    });
}

fn preflight_response(origin: Option<&str>) -> Response<Vec<u8>> {
    let mut resp = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Vec::new())
        .unwrap();
    add_cors_headers(resp.headers_mut(), origin);
    resp
}

fn with_cors(mut resp: Response<Vec<u8>>, origin: Option<&str>) -> Response<Vec<u8>> {
    add_cors_headers(resp.headers_mut(), origin);
    resp
}

fn add_cors_headers(h: &mut HeaderMap, origin: Option<&str>) {
    // Echo the request's Origin when present (required for credentialed
    // requests — ``*`` is rejected by the browser in that case). Fall
    // back to ``*`` for tooling/curl-style callers that omit Origin.
    let allow_origin = origin
        .and_then(|s| HeaderValue::from_str(s).ok())
        .unwrap_or_else(|| HeaderValue::from_static("*"));
    h.insert("Access-Control-Allow-Origin", allow_origin);
    h.insert("Access-Control-Allow-Credentials", HeaderValue::from_static("true"));
    // ``Vary: Origin`` so any intermediary cache doesn't reuse a response
    // generated for a different webview origin.
    h.insert("Vary", HeaderValue::from_static("Origin"));
    h.insert("Access-Control-Allow-Methods", HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"));
    h.insert("Access-Control-Allow-Headers", HeaderValue::from_static("*"));
    h.insert("Access-Control-Expose-Headers", HeaderValue::from_static("*"));
    h.insert("Access-Control-Max-Age", HeaderValue::from_static("600"));
}

async fn proxy<R: tauri::Runtime>(
    app: &AppHandle<R>,
    request: Request<Vec<u8>>,
) -> anyhow::Result<Response<Vec<u8>>> {
    let method = request.method().clone();
    let uri = request.uri().clone();

    let port = backend_port(app).context("backend not ready")?;
    let upstream_url = build_upstream_url(&uri, port)?;

    let body_len = request.body().len();
    log::info!(
        "proxy: {} {} → {} (body {} bytes)",
        method, uri.path(), upstream_url, body_len,
    );

    // Build the reqwest request mirroring the inbound shape.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(600)) // 10 min for big uploads
        .build()?;

    let req_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).context("method")?;
    let mut req = client.request(req_method, upstream_url.clone());

    for (name, value) in request.headers().iter() {
        // host header would point at meridian-api.localhost; let reqwest set
        // it from the URL. Origin/Referer would expose the custom scheme to
        // the server and confuse logs — strip them.
        let lower = name.as_str().to_ascii_lowercase();
        if lower == "host" || lower == "origin" || lower == "referer" {
            continue;
        }
        req = req.header(name.as_str(), value.as_bytes());
    }
    req = req.header("X-MyApp-ApiKey", DESKTOP_API_KEY);

    let body = request.into_body();
    if !body.is_empty() {
        req = req.body(body);
    }

    let t0 = std::time::Instant::now();
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            log::error!(
                "proxy: {} {} upstream failed after {:?}: {}",
                method, uri.path(), t0.elapsed(), e,
            );
            return Err(e.into());
        }
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let bytes = upstream.bytes().await.context("read upstream body")?;
    let resp_len = bytes.len();
    log::info!(
        "proxy: {} {} ← {} ({} bytes, {:?})",
        method, uri.path(), status, resp_len, t0.elapsed(),
    );

    let mut out = Response::builder().status(status);
    if let Some(headers) = out.headers_mut() {
        copy_headers(&upstream_headers, headers);
    }
    let response = out
        .body(bytes.to_vec())
        .context("build response")?;
    Ok(response)
}

fn build_upstream_url(uri: &http::Uri, port: u16) -> anyhow::Result<String> {
    let path = uri.path();
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    Ok(format!("http://127.0.0.1:{port}{path}{query}"))
}

fn backend_port<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<u16> {
    let state = app.try_state::<AppState>()?;
    let port = match &*state.status.lock() {
        BackendStatus::Ready { port } => Some(*port),
        _ => None,
    };
    port
}

fn copy_headers(src: &HeaderMap, dst: &mut HeaderMap) {
    for (k, v) in src.iter() {
        // content-length will be set by the response body length; let the
        // webview/http stack recompute it.
        let name = k.as_str().to_ascii_lowercase();
        if name == "content-length" || name == "transfer-encoding" {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(k.as_str().as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            dst.insert(name, value);
        }
    }
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    let body = serde_json::json!({ "error": message }).to_string();
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(body.into_bytes())
        .unwrap()
}
