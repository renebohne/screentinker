plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * ScreenTinker Manager (android-admin/): the Simple view of a ScreenTinker server in a WebView,
 * with phone-native extras (server picker, photo picker, Share from the Gallery, Advanced in the
 * browser). The player app is a separate project (android/, com.remotedisplay.player).
 *
 * targetSdk 36: Google Play requires new apps to target the latest major Android release.
 * Release signing reads the same kind of env/properties the player's build does, so a CI job can
 * sign without the keystore ever being committed.
 */
android {
    namespace = "com.screentinker.manager"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.screentinker.manager"
        minSdk = 26
        targetSdk = 36
        versionCode = (System.getenv("VERSION_CODE") ?: findProperty("VERSION_CODE") as String? ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: findProperty("VERSION_NAME") as String? ?: "1.0.0"
    }

    signingConfigs {
        create("release") {
            val ks = System.getenv("MANAGER_KEYSTORE") ?: findProperty("MANAGER_KEYSTORE") as String?
            if (ks != null) {
                storeFile = file(ks)
                storePassword = System.getenv("MANAGER_KEYSTORE_PASSWORD") ?: findProperty("MANAGER_KEYSTORE_PASSWORD") as String?
                keyAlias = System.getenv("MANAGER_KEY_ALIAS") ?: findProperty("MANAGER_KEY_ALIAS") as String?
                keyPassword = System.getenv("MANAGER_KEY_PASSWORD") ?: findProperty("MANAGER_KEY_PASSWORD") as String?
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val release = signingConfigs.getByName("release")
            if (release.storeFile != null) signingConfig = release
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.browser:browser:1.8.0")
    /*
     * 3.0 "Share my screen" (share/): the phone's screen to a ScreenTinker screen over WebRTC, the same
     * peer-to-peer signalling a browser's /share page uses. A WebView cannot capture the screen
     * (no getDisplayMedia on Android), so it is native: MediaProjection -> share/ProjectionCapturer
     * -> libwebrtc. The SAME libwebrtc build the player app ships (android/), and OkHttp for
     * the signalling WebSocket, as there.
     */
    implementation("io.getstream:stream-webrtc-android:1.3.10")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // "Scan the code on the screen": Google's code scanner UI from Play services — no camera
    // permission for this app, nothing to bundle. Without Play services the person types the code.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // Play services brings an old androidx.fragment; registerForActivityResult needs 1.3+ (lint).
    implementation("androidx.fragment:fragment:1.8.6")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
}
