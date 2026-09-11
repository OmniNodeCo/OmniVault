package co.omninode.omnivault;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * OmniVault Android app.
 *
 * By default this is a STANDALONE LOCAL VAULT: the entire web app (the
 * repo's public/ folder) is bundled into the APK assets at build time and
 * served here on the secure https://appassets.androidplatform.net origin —
 * a placeholder origin that is intercepted locally and never reaches the
 * network. WebCrypto and IndexedDB work, the vault lives entirely in the
 * app's private storage, and no server or URL configuration is needed.
 *
 * Optionally build with -PvaultUrl=https://your-server to make the same APK
 * open a self-hosted OmniVault server instead (sync mode).
 *
 * In-app updates: the app checks the GitHub Releases "latest" endpoint (see
 * the updateUrl property in build.gradle) once a day and on demand from the
 * menu; a newer version offers a "Go to release" button that opens the
 * release page in the system browser. Disable at build time with
 * -PupdateUrl= (empty).
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final String STATE_URL = "omnivault.url";

    /** Placeholder https origin for serving bundled assets (offline only). */
    private static final String ASSETS_ORIGIN = "https://appassets.androidplatform.net";
    private static final String LOCAL_START_URL = ASSETS_ORIGIN + "/index.html";

    /** Update checks: at most once a day automatically, plus manual via menu. */
    private static final long UPDATE_CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000;
    private static final String PREFS_NAME = "omnivault";
    private static final String PREF_LAST_UPDATE_CHECK = "last_update_check";
    private static final int MENU_CHECK_UPDATES = 1;

    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> pendingFileCallback;
    private boolean localVault;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);

        localVault = configuredUrl().isEmpty();
        final Uri startUri = Uri.parse(startUrl());

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // DOM storage (IndexedDB + sessionStorage) is where the local vault lives.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setBackgroundColor(Color.parseColor("#0B1020"));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Local-vault mode: every request is served from bundled APK
                // assets — nothing ever leaves the device, except the GitHub
                // Releases API used by Settings → "Check for updates".
                if (localVault) {
                    String host = request.getUrl().getHost();
                    if ("api.github.com".equalsIgnoreCase(host)) {
                        return null; // pass through to the network
                    }
                    return serveAsset(request.getUrl().getPath());
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                if (scheme.equals("http") || scheme.equals("https")) {
                    // The vault stays in the app; anything else goes to the browser.
                    return !sameOrigin(startUri, uri);
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri)); // mailto:, tel:, …
                } catch (ActivityNotFoundException ignored) {
                    // No handler — nothing sensible to do.
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only relevant in server mode; local assets always load.
                if (!localVault && request.isForMainFrame()) {
                    showOfflinePage();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                } catch (ActivityNotFoundException e) {
                    pendingFileCallback = null;
                    return false;
                }
                return true;
            }
        });

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        // Expose autofill controls to the web app. Only the annotated
        // methods below are reachable from JavaScript (safe on API 17+).
        webView.addJavascriptInterface(new VaultBridge(getApplicationContext()), "OmniVaultAndroid");

        maybeCheckForUpdates();

        if (savedInstanceState != null) {
            String restored = savedInstanceState.getString(STATE_URL);
            if (restored != null) {
                webView.restoreState(savedInstanceState);
                webView.loadUrl(restored);
                return;
            }
        }
        webView.loadUrl(startUrl());
    }

    // ------------------------------------------------------------- local app

    private static String configuredUrl() {
        return BuildConfig.VAULT_URL == null ? "" : BuildConfig.VAULT_URL.trim();
    }

    private static String startUrl() {
        String configured = configuredUrl();
        return configured.isEmpty() ? LOCAL_START_URL : configured;
    }

    /**
     * Serve a file from the bundled assets. Called on a background thread —
     * only touches the thread-safe AssetManager, never the UI.
     */
    private WebResourceResponse serveAsset(String path) {
        if (path == null) path = "/";
        if (path.isEmpty() || "/".equals(path)) path = "/index.html";
        if (path.contains("..")) return notFound(); // no traversal
        String rel = path.startsWith("/") ? path.substring(1) : path;
        try {
            InputStream input = getAssets().open(rel);
            return new WebResourceResponse(mimeFor(rel), "utf-8", input);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse(
                "text/plain", "utf-8", 404, "Not Found",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".txt")) return "text/plain";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    // -------------------------------------------------------------- updates

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_CHECK_UPDATES, 0, "Check for updates");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == MENU_CHECK_UPDATES) {
            checkForUpdates(true);
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    /** Automatic daily check; silently does nothing when disabled/stale. */
    private void maybeCheckForUpdates() {
        if (BuildConfig.UPDATE_URL.isEmpty()) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long last = prefs.getLong(PREF_LAST_UPDATE_CHECK, 0);
        if (now - last < UPDATE_CHECK_INTERVAL_MS) return;
        checkForUpdates(false);
    }

    /** Fetches the latest-release JSON and compares it with this build. */
    private void checkForUpdates(boolean manual) {
        final String updateUrl = BuildConfig.UPDATE_URL;
        if (updateUrl.isEmpty()) {
            if (manual) toast("Update checks are disabled in this build");
            return;
        }
        final Handler ui = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            String tag = null, pageUrl = null, error = null;
            try {
                JSONObject release = new JSONObject(httpGet(updateUrl));
                tag = release.optString("tag_name", "");
                pageUrl = release.optString("html_url", "");
            } catch (Exception e) {
                error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            }
            final String fTag = tag, fPage = pageUrl, fError = error;
            ui.post(() -> {
                getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                        .putLong(PREF_LAST_UPDATE_CHECK, System.currentTimeMillis())
                        .apply();
                if (fError != null) {
                    if (manual) toast("Update check failed: " + fError);
                    return;
                }
                String remote = fTag != null && fTag.startsWith("v") ? fTag.substring(1) : fTag;
                if (remote == null || remote.isEmpty()
                        || compareVersions(remote, BuildConfig.VERSION_NAME) <= 0) {
                    if (manual) toast("OmniVault " + BuildConfig.VERSION_NAME + " is up to date");
                    return;
                }
                offerUpdate(fTag, fPage);
            });
        }, "omnivault-update-check").start();
    }

    /** "Update available" dialog — one tap opens the release page in the browser. */
    private void offerUpdate(String tag, String pageUrl) {
        final String url = pageUrl == null || pageUrl.isEmpty()
                ? "https://github.com/OmniNodeCo/OmniVault/releases/latest"
                : pageUrl;
        new AlertDialog.Builder(this)
                .setTitle("Update available")
                .setMessage("OmniVault " + tag + " is available. Open the release page in your browser?")
                .setPositiveButton("Go to release", (dialog, which) -> openInBrowser(url))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void openInBrowser(String url) {
        if (url == null || url.isEmpty()) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) {
            toast("No browser available");
        }
    }

    private static String httpGet(String urlStr) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(urlStr).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "OmniVault-Android");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("HTTP " + status);
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
            reader.close();
            return body.toString();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Numeric dotted-version compare ("1.10.0" > "1.9.2"); ignores non-numerics. */
    private static int compareVersions(String a, String b) {
        String[] x = a.replaceAll("[^0-9.]", "").split("\\.");
        String[] y = b.replaceAll("[^0-9.]", "").split("\\.");
        int len = Math.max(x.length, y.length);
        for (int i = 0; i < len; i++) {
            int xi = i < x.length && !x[i].isEmpty() ? Integer.parseInt(x[i]) : 0;
            int yi = i < y.length && !y[i].isEmpty() ? Integer.parseInt(y[i]) : 0;
            if (xi != yi) return Integer.compare(xi, yi);
        }
        return 0;
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    // ---------------------------------------------------- autofill bridge

    /**
     * JavaScript interface for the bundled web app (window.OmniVaultAndroid).
     * The web app publishes an encrypted credential index for the autofill
     * service while the vault is unlocked; all methods run on a binder
     * thread and touch only thread-safe storage.
     */
    private static class VaultBridge {
        private final Context context;

        VaultBridge(Context context) {
            this.context = context;
        }

        @JavascriptInterface
        public void setAutofillData(String json) {
            if (json == null) return;
            AutofillStore.save(context, json);
        }

        @JavascriptInterface
        public void setAutofillEnabled(boolean enabled) {
            AutofillStore.setEnabled(context, enabled);
        }
    }

    // ------------------------------------------------------------------ misc

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
        outState.putString(STATE_URL, webView.getUrl());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    /** Host (+ effective port) comparison so vault URLs stay in the WebView. */
    private static boolean sameOrigin(Uri vault, Uri target) {
        String vh = vault.getHost();
        String th = target.getHost();
        if (vh == null || th == null || !vh.equalsIgnoreCase(th)) {
            return false;
        }
        int vp = vault.getPort() == -1 ? defaultPort(vault.getScheme()) : vault.getPort();
        int tp = target.getPort() == -1 ? defaultPort(target.getScheme()) : target.getPort();
        return vp == tp;
    }

    private static int defaultPort(String scheme) {
        if (scheme == null) return -1;
        switch (scheme.toLowerCase()) {
            case "https": return 443;
            case "http": return 80;
            default: return -1;
        }
    }

    /** Stand-in page for server mode when the vault server is unreachable. */
    private void showOfflinePage() {
        String url = startUrl();
        String html =
                "<html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
                "<style>body{background:#0B1020;color:#E6EAF4;font-family:system-ui,sans-serif;" +
                "display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}" +
                "h2{font-weight:600}button{background:#6366F1;color:#fff;border:0;border-radius:10px;" +
                "padding:12px 22px;font-size:15px;font-weight:600}</style></head><body>" +
                "<div><h2>Can't reach the vault</h2>" +
                "<p style=\"color:#9AA4C0\">Check your internet connection or the server address.</p>" +
                "<button onclick=\"location.href='" + url + "'\">Try again</button></div>" +
                "</body></html>";
        progress.setVisibility(View.GONE);
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }
}
