package net.focusbro.app.focuslock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * Source-level contracts for APP-LOCK1 S0 (spec r4 §5.3, §5.8 rules half, §5.10; jc-security #35090). Gradle runs unit tests
 * with the module directory (mobile/android/app) as the working directory.
 */
public class ManifestContractTest {

    private static final String A = "http://schemas.android.com/apk/res/android";
    private static final Set<String> ALLOWED = new HashSet<>(Arrays.asList(
        "android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.POST_NOTIFICATIONS",
        "android.permission.SCHEDULE_EXACT_ALARM", "android.permission.RECEIVE_BOOT_COMPLETED", "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK", "android.permission.WAKE_LOCK"));

    private static Document xml(String path) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(true);
        return f.newDocumentBuilder().parse(new File(path));
    }

    @Test
    public void noNewPermissionAndNoFullScreenIntent() throws Exception {
        NodeList perms = xml("src/main/AndroidManifest.xml").getElementsByTagName("uses-permission");
        Set<String> found = new HashSet<>();
        for (int i = 0; i < perms.getLength(); i++) found.add(((Element) perms.item(i)).getAttributeNS(A, "name"));
        assertEquals("S0 adds no permission (§5.3)", ALLOWED, found);
        assertFalse(found.contains("android.permission.USE_FULL_SCREEN_INTENT"));
    }

    @Test
    public void everyFocusLockComponentIsNotExported() throws Exception {
        Document d = xml("src/main/AndroidManifest.xml");
        int seen = 0;
        for (String tag : new String[] {"activity", "receiver", "service", "provider"}) {
            NodeList n = d.getElementsByTagName(tag);
            for (int i = 0; i < n.getLength(); i++) {
                Element e = (Element) n.item(i);
                if (!e.getAttributeNS(A, "name").contains("focuslock")) continue;
                seen++;
                assertEquals(e.getAttributeNS(A, "name") + " must be exported=false (AL-S3)", "false", e.getAttributeNS(A, "exported"));
            }
        }
        assertEquals("RoutineActivity, RoutineAlarm, BootReceiver", 3, seen);
    }

    @Test
    public void routineStoreIsExcludedFromBackupAndTransfer() throws Exception {
        Element app = (Element) xml("src/main/AndroidManifest.xml").getElementsByTagName("application").item(0);
        assertEquals("@xml/focuslock_backup_rules", app.getAttributeNS(A, "fullBackupContent"));
        assertEquals("@xml/focuslock_extraction_rules", app.getAttributeNS(A, "dataExtractionRules"));
        String file = RoutineStore.PREFS + ".xml";
        assertTrue(excludes(xml("src/main/res/xml/focuslock_backup_rules.xml").getDocumentElement(), file));
        Document ext = xml("src/main/res/xml/focuslock_extraction_rules.xml");
        assertTrue("cloud backup", excludes((Element) ext.getElementsByTagName("cloud-backup").item(0), file));
        assertTrue("device-to-device transfer", excludes((Element) ext.getElementsByTagName("device-transfer").item(0), file));
    }

    private static boolean excludes(Element scope, String file) {
        NodeList ex = scope.getElementsByTagName("exclude");
        for (int i = 0; i < ex.getLength(); i++) {
            Element e = (Element) ex.item(i);
            if ("sharedpref".equals(e.getAttribute("domain")) && file.equals(e.getAttribute("path"))) return true;
        }
        return false;
    }

    @Test
    public void noGenericBridgeRouteAndNoFullScreenIntentInSource() throws Exception {
        File dir = new File("src/main/java/net/focusbro/app/focuslock");
        File[] files = dir.listFiles((d, n) -> n.endsWith(".java"));
        assertTrue(files != null && files.length >= 6);
        for (File f : files) {
            String src = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            assertFalse(f.getName() + ": no @PluginMethod, so Capacitor's bridge has no FocusLock route", src.contains("@PluginMethod"));
            assertFalse(f.getName() + ": no full-screen intent (AL-S4)", src.contains("setFullScreenIntent"));
            assertFalse(f.getName() + ": no addJavascriptInterface", src.contains("addJavascriptInterface"));
            if (src.contains("PendingIntent.get")) assertTrue(f.getName() + ": every PendingIntent is immutable", src.contains("FLAG_IMMUTABLE"));
        }
    }
}
