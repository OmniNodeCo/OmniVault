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
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

/**
 * OmniVault Android wrapper.
 *
 * A deliberately thin, dependency-free WebView shell around the OmniVault
 * PWA. All encryption still happens inside the web app (WebCrypto in the
 * WebView), so this activity only needs to:
 *   - load the configured vault URL,
 *   - keep vault URLs inside the app and send external links to the browser,
 *   - support the image upload file chooser,
 *   - handle back navigation and state restoration,
 *   - show a friendly offline screen.
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final String STATE_URL = "omnivault.url";

    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> pendingFileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);

        final Uri vaultUri = Uri.parse(BuildConfig.VAULT_URL);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // DOM storage (sessionStorage) is how the web app keeps the vault
        // unlocked for the session and locks it when the app closes.
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setBackgroundColor(Color.parseColor("#0B1020"));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                if (scheme.equals("http") || scheme.equals("https")) {
                    // The vault itself stays in the app; anything else goes to the browser.
                    return !sameOrigin(vaultUri, uri);
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
                if (request.isForMainFrame()) {
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
        webView.loadUrl(BuildConfig.VAULT_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
        outState.putString(STATE_URL, webView.getUrl());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            Uri[] result = null;
            if (pendingFileCallback != null) {
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
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

    /** Stand-in page when the vault server is unreachable. */
    private void showOfflinePage() {
        String url = BuildConfig.VAULT_URL;
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
