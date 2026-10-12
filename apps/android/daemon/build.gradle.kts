plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.rivulet.sync"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.rivulet.sync"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // The emulator reaches the host machine's localhost at 10.0.2.2.
        buildConfigField("String", "DEFAULT_SERVER", "\"http://10.0.2.2:8787\"")
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/engine-assets"))
}

// The daemon runs the engine's own source, unmodified, in a WebView. Copy it in
// at build time so there is one engine, not a fork that drifts.
val copyEngine = tasks.register<Sync>("copyEngine") {
    from(rootProject.file("../../src")) {
        exclude("**/*.test.js", "server/**")
    }
    into(layout.buildDirectory.dir("generated/engine-assets/engine/src"))
}
tasks.named("preBuild") { dependsOn(copyEngine) }
