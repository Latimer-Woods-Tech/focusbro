package net.focusbro.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import net.focusbro.app.focuslock.FocusLockInstaller;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // APP-LOCK1 S0: registered before the bridge exists so its load() runs before the page loads (focuslock/FocusLockInstaller).
        registerPlugin(FocusLockInstaller.class);
        super.onCreate(savedInstanceState);

        // Hardware back walks the webview history and only leaves the app at the
        // root — the same behaviour as Capricast's shell. Registered last, so it
        // takes precedence over Capacitor's default handling.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
            }
        });
    }
}
