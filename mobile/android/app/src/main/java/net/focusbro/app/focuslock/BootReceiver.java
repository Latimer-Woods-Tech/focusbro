package net.focusbro.app.focuslock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Re-arms the routine alarm after a reboot or an app update. Does nothing when the routine is off. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        Routine r = Prefs.store(context).load();
        if (r != null) RoutineAlarm.schedule(context, r);
    }
}
