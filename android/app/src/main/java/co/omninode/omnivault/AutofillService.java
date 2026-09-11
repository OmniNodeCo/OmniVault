package co.omninode.omnivault;

import android.app.assist.AssistStructure;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.Dataset;
import android.service.autofill.FillCallback;
import android.service.autofill.FillContext;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveRequest;
import android.text.InputType;
import android.view.View;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * System autofill provider: offers vault credentials to Chrome and other
 * apps (Android 8+). The matching index lives in AutofillStore — hardware
 * key encrypted, published by the web app while the vault is unlocked and
 * wiped on lock/logout. Enable once under system Settings → Passwords &
 * autofill → OmniVault.
 */
public class AutofillService extends AutofillService {

    private static final int MAX_DATASETS = 5;

    /** Login fields found on the current screen. */
    private static final class Fields {
        AutofillId username;
        AutofillId password;
        String webDomain;
    }

    @Override
    public void onFillRequest(FillRequest request, CancellationSignal signal, FillCallback callback) {
        try {
            if (!AutofillStore.isEnabled(this)) {
                callback.onSuccess(null);
                return;
            }
            String json = AutofillStore.load(this);
            if (json == null) {
                callback.onSuccess(null);
                return;
            }

            List<FillContext> contexts = request.getFillContexts();
            AssistStructure structure = contexts.get(contexts.size() - 1).getStructure();
            Fields fields = new Fields();
            for (int i = 0; i < structure.getWindowNodeCount(); i++) {
                walk(structure.getWindowNodeAt(i).getRootViewNode(), fields);
            }
            if (fields.username == null && fields.password == null) {
                callback.onSuccess(null); // not a login screen
                return;
            }

            String pkg = packageNameOf(structure);
            JSONArray entries = new JSONArray(json);
            FillResponse.Builder response = new FillResponse.Builder();
            int added = 0;
            for (int i = 0; i < entries.length() && added < MAX_DATASETS; i++) {
                JSONObject entry = entries.getJSONObject(i);
                if (!matches(entry, fields.webDomain, pkg)) continue;
                Dataset dataset = dataset(entry, fields);
                if (dataset == null) continue;
                response.addDataset(dataset);
                added++;
            }
            callback.onSuccess(added > 0 ? response.build() : null);
        } catch (Exception e) {
            // Never crash the caller's app — just decline to fill.
            try {
                callback.onSuccess(null);
            } catch (Exception ignored) {
                // callback already used
            }
        }
    }

    @Override
    public void onSaveRequest(SaveRequest request, SaveCallback callback) {
        // Saving new logins happens inside the vault itself.
        callback.onSuccess(null);
    }

    // ------------------------------------------------------------- matching

    private String packageNameOf(AssistStructure structure) {
        try {
            return structure.getActivityComponent().getPackageName();
        } catch (Exception e) {
            return null;
        }
    }

    private boolean matches(JSONObject entry, String domain, String pkg) {
        try {
            JSONArray hosts = entry.optJSONArray("hosts");
            if (domain != null && !domain.isEmpty()) {
                String lower = domain.toLowerCase();
                for (int i = 0; hosts != null && i < hosts.length(); i++) {
                    String host = hosts.optString(i, "").toLowerCase();
                    if (host.isEmpty()) continue;
                    if (lower.equals(host) || lower.endsWith("." + host)) return true;
                }
                return false;
            }
            // Native app without a web domain: offer entries saved without a URL.
            return (hosts == null || hosts.length() == 0) && pkg != null && !pkg.equals(getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    private Dataset dataset(JSONObject entry, Fields fields) {
        try {
            String title = entry.optString("title", "");
            String username = entry.optString("username", "");
            String password = entry.optString("password", "");
            if (password.isEmpty()) return null;

            RemoteViews presentation = new RemoteViews(getPackageName(), R.layout.autofill_item);
            presentation.setTextViewText(
                    R.id.autofill_title, username.isEmpty() ? title : title + " · " + username);
            presentation.setTextViewText(R.id.autofill_subtitle, "OmniVault");

            Dataset.Builder builder = new Dataset.Builder();
            builder.setPresentation(presentation);
            if (fields.username != null && !username.isEmpty()) {
                builder.setValue(fields.username, AutofillValue.forText(username));
            }
            if (fields.password != null) {
                builder.setValue(fields.password, AutofillValue.forText(password));
            }
            return builder.build();
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------ structure

    /** Depth-first scan for the web domain + username/password fields. */
    private static void walk(AssistStructure.ViewNode node, Fields fields) {
        if (node == null) return;

        if (fields.webDomain == null) {
            String domain = node.getWebDomain();
            if (domain != null) fields.webDomain = domain;
        }

        AutofillId id = node.getAutofillId();
        if (id != null) {
            boolean password = isPasswordField(node);
            if (password && fields.password == null) {
                fields.password = id;
            } else if (!password
                    && node.getAutofillType() == View.AUTOFILL_TYPE_TEXT
                    && isUsernameField(node)
                    && fields.password == null) {
                // Keep the last username-ish field found before the password.
                fields.username = id;
            }
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            walk(node.getChildAt(i), fields);
        }
    }

    private static boolean isPasswordField(AssistStructure.ViewNode node) {
        String[] hints = node.getAutofillHints();
        if (hints != null) {
            for (String hint : hints) {
                if (hint != null && hint.contains(View.AUTOFILL_HINT_PASSWORD)) return true;
            }
        }
        int klass = node.getInputType() & InputType.TYPE_MASK_CLASS;
        int variation = node.getInputType() & InputType.TYPE_MASK_VARIATION;
        return klass == InputType.TYPE_CLASS_TEXT
                && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                        || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                        || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
    }

    private static boolean isUsernameField(AssistStructure.ViewNode node) {
        String[] hints = node.getAutofillHints();
        if (hints != null) {
            for (String hint : hints) {
                if (hint != null
                        && (hint.contains(View.AUTOFILL_HINT_USERNAME)
                                || hint.contains(View.AUTOFILL_HINT_EMAIL_ADDRESS))) {
                    return true;
                }
            }
        }
        // Fallback: any text input can hold the username.
        return node.getInputType() != 0;
    }
}
