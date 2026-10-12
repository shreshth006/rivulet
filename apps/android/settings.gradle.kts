pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "rivulet-android"

// daemon: the background sync service other apps talk to
// client: the small library those apps use to talk to it
// notes:  an example app built only on `client`
include(":daemon", ":client", ":notes")
