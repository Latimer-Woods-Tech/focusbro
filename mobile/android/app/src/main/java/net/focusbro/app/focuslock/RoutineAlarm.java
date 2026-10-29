package net.focusbro.app.focuslock;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Calendar;

/**
 * The morning nudge: an exact alarm when the person allowed exact alarms (already in the manifest for check-ins), an inexact
 * one otherwise. When it fires it posts an ORDINARY notification that opens the native routine screen: no full-screen intent,
 * no lock-screen takeover (spec r4 §2.6, AL-S4). Every PendingIntent is FLAG_IMMUTABLE (Arch PF-G1 condition).
 */
public final class RoutineAlarm extends BroadcastReceiver {

    static final String CHANNEL = "routine";
    static final int NOTIFICATION_ID = 7101;

    @Override
    public void onReceive(Context context, Intent intent) {
        RoutineStore store = Prefs.store(context);
        Routine r = store.load();
        if (r == null) return;
        String today = Prefs.today();
        boolean[] done = store.doneToday(today);
        boolean allDone = done.length > 0;
        for (boolean d : done) allDone &= d;
        if (!store.skippedToday(today) && !allDone) notifyRoutine(context);
        schedule(context, r);
    }

    /** Arm the next occurrence (today if still ahead, else tomorrow). Safe to call repeatedly: one PendingIntent, replaced. */
    public static void schedule(Context context, Routine r) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Calendar at = Calendar.getInstance();
        at.set(Calendar.HOUR_OF_DAY, r.hour);
        at.set(Calendar.MINUTE, r.minute);
        at.set(Calendar.SECOND, 0);
        at.set(Calendar.MILLISECOND, 0);
        if (at.getTimeInMillis() <= System.currentTimeMillis()) at.add(Calendar.DAY_OF_YEAR, 1);
        PendingIntent pi = alarmIntent(context);
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms();
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.getTimeInMillis(), pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.getTimeInMillis(), pi);
    }

    public static void cancel(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(context));
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
    }

    static PendingIntent alarmIntent(Context context) {
        Intent i = new Intent(context, RoutineAlarm.class);
        return PendingIntent.getBroadcast(context, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void notifyRoutine(Context context) {
        // Notifications denied (Android 13+): post nothing; the routine still opens from the launcher shortcut (spec r4 §2.4).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Morning routine", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(context, RoutineActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent content = PendingIntent.getActivity(context, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(net.focusbro.app.R.drawable.ic_stat_focusbro)
            .setContentTitle("Your morning routine")
            .setContentText("Open it when you're ready. You can skip today.")
            .setContentIntent(content)
            .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, b.build());
        } catch (SecurityException e) {
            // Permission revoked between the check and the post: nothing is shown; the shortcut still works.
        }
    }
}
