# The WebView calls these by name (window.STManager.*): keep them through R8.
-keepclassmembers class com.screentinker.manager.ManagerBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# 3.0 screen share: libwebrtc calls back into its Java classes from native code by name.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
