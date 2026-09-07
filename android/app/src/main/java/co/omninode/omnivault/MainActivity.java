package co.omninode.omnivault;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
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
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final String STATE_URL = "omnivault.url";

    /** Placeholder https origin for serving bundled assets (offline only). */
    private static final String ASSETS_ORIGIN = "https://appassets.androidplatform.net";
    private static final String LOCAL_START_URL = ASSETS_ORIGIN + "/index.html";

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
                // assets — nothing ever leaves the device.
                if (localVault) {
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
                Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                pendingFileCallback.onReceiveValue(result);
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
