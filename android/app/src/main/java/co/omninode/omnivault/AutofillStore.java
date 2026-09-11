package co.omninode.omnivault;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encrypted native cache of vault credentials for the autofill service.
 *
 * The web app publishes a small JSON index (url/username/password per
 * password item) while the vault is unlocked; it is stored AES-GCM
 * encrypted with a key that lives in the Android Keystore and never leaves
 * the device. Locking or logging out wipes the cache.
 */
final class AutofillStore {

    private static final String PREFS = "omnivault_autofill";
    private static final String KEY_DATA = "data";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEYSTORE_ALIAS = "ov_autofill_key";
    private static final int GCM_IV_BYTES = 12;

    private AutofillStore() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Autofill is on by default; disabled from the app's Settings screen. */
    static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, true);
    }

    static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply();
        if (!enabled) clear(context);
    }

    /** Encrypt and store the credential index JSON. */
    static void save(Context context, String json) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] ciphertext = cipher.doFinal(json.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] out = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ciphertext, 0, out, iv.length, ciphertext.length);
            prefs(context)
                    .edit()
                    .putString(KEY_DATA, Base64.encodeToString(out, Base64.NO_WRAP))
                    .apply();
        } catch (Exception e) {
            clear(context);
        }
    }

    /** Decrypt and return the credential index JSON, or null when absent. */
    static String load(Context context) {
        try {
            String encoded = prefs(context).getString(KEY_DATA, null);
            if (encoded == null) return null;
            byte[] blob = Base64.decode(encoded, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, blob, 0, GCM_IV_BYTES));
            byte[] plain = cipher.doFinal(blob, GCM_IV_BYTES, blob.length - GCM_IV_BYTES);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    /** Wipe the cached credentials (keeps the enabled flag). */
    static void clear(Context context) {
        prefs(context).edit().remove(KEY_DATA).apply();
    }

    private static SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        SecretKey existing = (SecretKey) keyStore.getKey(KEYSTORE_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
        generator.init(
                new KeyGenParameterSpec.Builder(
                                KEYSTORE_ALIAS,
                                KeyGenParameterSpec.PURPOSE_ENCRYPT | KeyGenParameterSpec.PURPOSE_DECRYPT)
                        .setBlockModes(KeyGenParameterSpec.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyGenParameterSpec.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build());
        return generator.generateKey();
    }
}
